import {
  Injectable,
  Logger,
  ServiceUnavailableException,
  type OnModuleDestroy,
} from '@nestjs/common';
import { chromium, type Browser } from 'playwright';

const MAX_CONCURRENT_RENDERS = 2;
const MAX_QUEUED_RENDERS = 20;
const RENDER_TIMEOUT_MS = 15_000;

/**
 * HTML → PDF with one shared Chromium. The browser starts on first use and is
 * reused; each render gets its own isolated context. Knows nothing about
 * assessments, so it can move to a separate service without changing callers.
 */
@Injectable()
export class PdfRendererService implements OnModuleDestroy {
  private readonly logger = new Logger(PdfRendererService.name);
  private browserPromise: Promise<Browser> | undefined;
  private activeRenders = 0;
  private readonly waiting: Array<() => void> = [];

  async render(html: string): Promise<Buffer> {
    await this.acquireSlot();

    try {
      return await this.renderPdf(html);
    } finally {
      this.releaseSlot();
    }
  }

  async onModuleDestroy(): Promise<void> {
    const pending = this.browserPromise;
    this.browserPromise = undefined;

    if (pending) {
      const browser = await pending.catch(() => undefined);
      await browser?.close();
    }
  }

  private async renderPdf(html: string): Promise<Buffer> {
    const browser = await this.getBrowser();
    // No scripts and no network: the HTML is self-contained (logo is a data
    // URI), so nothing in a document can run code or reach another host.
    const context = await browser.newContext({ javaScriptEnabled: false });

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      // Closing the context rejects whatever the render is waiting on.
      context.close().catch(() => undefined);
    }, RENDER_TIMEOUT_MS);

    try {
      await context.route('**/*', (route) => route.abort());
      const page = await context.newPage();
      await page.setContent(html, { waitUntil: 'load' });

      // preferCSSPageSize lets the theme's @page rule set paper and margins.
      return await page.pdf({ preferCSSPageSize: true, printBackground: true });
    } catch (error) {
      if (timedOut) {
        throw new ServiceUnavailableException('PDF rendering timed out');
      }
      throw error;
    } finally {
      clearTimeout(timer);
      await context.close().catch(() => undefined);
    }
  }

  private getBrowser(): Promise<Browser> {
    if (!this.browserPromise) {
      const launching: Promise<Browser> = chromium.launch().then((browser) => {
        // Relaunch on the next render if Chromium crashes or is killed.
        browser.on('disconnected', () => {
          if (this.browserPromise === launching) {
            this.browserPromise = undefined;
            this.logger.warn('Chromium disconnected; it will be relaunched');
          }
        });
        return browser;
      });

      launching.catch(() => {
        if (this.browserPromise === launching) {
          this.browserPromise = undefined;
        }
      });

      this.browserPromise = launching;
    }

    return this.browserPromise;
  }

  private async acquireSlot(): Promise<void> {
    if (this.activeRenders < MAX_CONCURRENT_RENDERS) {
      this.activeRenders++;
      return;
    }

    if (this.waiting.length >= MAX_QUEUED_RENDERS) {
      throw new ServiceUnavailableException('PDF rendering queue is full');
    }

    // The slot is handed over by releaseSlot, so activeRenders stays as is.
    await new Promise<void>((resolve) => this.waiting.push(resolve));
  }

  private releaseSlot(): void {
    const next = this.waiting.shift();

    if (next) {
      next();
    } else {
      this.activeRenders--;
    }
  }
}
