import {
  EmailVerificationService,
  type IssuedSession,
  SignInService,
} from '@nestjs/authentication';
import { UnauthorizedException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import type { MockedFunction } from 'vitest';
import type { User } from '../db/schemas/user.js';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';

const buildUser = (overrides: Partial<User> = {}): User => ({
  id: '00000000-0000-0000-0000-000000000000',
  name: 'Test User',
  email: 'test@example.com',
  emailVerified: false,
  passwordHash: 'hashed-password',
  loginProvider: 'LOCAL',
  googleSubject: null,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  cycleAnchorAt: new Date('2026-01-01T00:00:00.000Z'),
  ...overrides,
});

const buildIssuedSession = (mfa: string): IssuedSession =>
  ({
    session: { mfa },
    token: 'token',
    cookie: 'cookie',
  }) as unknown as IssuedSession;

const createAuthServiceMock = () => ({
  createAccount: vi.fn() as unknown as MockedFunction<
    AuthService['createAccount']
  >,
  logInAccount: vi.fn() as unknown as MockedFunction<
    AuthService['logInAccount']
  >,
});

const createSignInServiceMock = () => ({
  signIn: vi.fn() as unknown as MockedFunction<SignInService['signIn']>,
});

const createEmailVerificationServiceMock = () => ({
  send: vi.fn() as unknown as MockedFunction<
    EmailVerificationService['send']
  >,
});

describe('AuthController', () => {
  let controller: AuthController;
  let authService: ReturnType<typeof createAuthServiceMock>;
  let signInService: ReturnType<typeof createSignInServiceMock>;
  let emailVerificationService: ReturnType<
    typeof createEmailVerificationServiceMock
  >;

  beforeEach(async () => {
    authService = createAuthServiceMock();
    signInService = createSignInServiceMock();
    emailVerificationService = createEmailVerificationServiceMock();

    signInService.signIn.mockResolvedValue(buildIssuedSession('none'));
    emailVerificationService.send.mockResolvedValue({ expiresAt: new Date() });
    vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const module: TestingModule = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [
        { provide: AuthService, useValue: authService },
        { provide: SignInService, useValue: signInService },
        {
          provide: EmailVerificationService,
          useValue: emailVerificationService,
        },
      ],
    }).compile();

    controller = module.get<AuthController>(AuthController);
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('registerUser', () => {
    const body = {
      email: 'new@example.com',
      name: 'New User',
      password: 'plain-password',
    };

    it('should create the account, sign the user in, send the verification email and return the user when the body is valid', async () => {
      // Arrange
      const user = buildUser({ email: body.email, name: body.name });
      authService.createAccount.mockResolvedValue(user);

      // Act
      const result = await controller.registerUser(body);

      // Assert
      expect(authService.createAccount).toHaveBeenCalledTimes(1);
      expect(authService.createAccount).toHaveBeenCalledWith(body);
      expect(signInService.signIn).toHaveBeenCalledWith(user.id, {
        method: 'password',
      });
      expect(emailVerificationService.send).toHaveBeenCalledWith(user);
      expect(result).toBe(user);
    });

    it('should propagate the error and not sign in when AuthService.createAccount fails', async () => {
      // Arrange
      const error = new Error('Email already exists');
      authService.createAccount.mockRejectedValue(error);

      // Act & Assert
      await expect(controller.registerUser(body)).rejects.toBe(error);
      expect(signInService.signIn).not.toHaveBeenCalled();
      expect(emailVerificationService.send).not.toHaveBeenCalled();
    });

    it('should propagate the error and not send the email when signing in fails', async () => {
      // Arrange
      const error = new Error('sign in failed');
      authService.createAccount.mockResolvedValue(buildUser());
      signInService.signIn.mockRejectedValue(error);

      // Act & Assert
      await expect(controller.registerUser(body)).rejects.toBe(error);
      expect(emailVerificationService.send).not.toHaveBeenCalled();
    });

    it('should propagate the error when sending the verification email fails', async () => {
      // Arrange
      const error = new Error('smtp down');
      authService.createAccount.mockResolvedValue(buildUser());
      emailVerificationService.send.mockRejectedValue(error);

      // Act & Assert
      await expect(controller.registerUser(body)).rejects.toBe(error);
    });
  });

  describe('loginUser', () => {
    const body = { email: 'test@example.com', password: 'plain-password' };

    it('should sign the user in and report mfaRequired false when the session has no pending MFA', async () => {
      // Arrange
      const user = buildUser();
      authService.logInAccount.mockResolvedValue(user);

      // Act
      const result = await controller.loginUser(body);

      // Assert
      expect(authService.logInAccount).toHaveBeenCalledTimes(1);
      expect(authService.logInAccount).toHaveBeenCalledWith(body);
      expect(signInService.signIn).toHaveBeenCalledWith(user.id, {
        method: 'password',
      });
      expect(result).toEqual({ mfaRequired: false });
    });

    it('should report mfaRequired true when the session MFA is pending', async () => {
      // Arrange
      authService.logInAccount.mockResolvedValue(buildUser());
      signInService.signIn.mockResolvedValue(buildIssuedSession('pending'));

      // Act
      const result = await controller.loginUser(body);

      // Assert
      expect(result).toEqual({ mfaRequired: true });
    });

    it('should throw UnauthorizedException and not sign in when AuthService.logInAccount returns no user', async () => {
      // Arrange
      authService.logInAccount.mockResolvedValue(
        undefined as unknown as User,
      );

      // Act & Assert
      await expect(controller.loginUser(body)).rejects.toThrow(
        UnauthorizedException,
      );
      expect(signInService.signIn).not.toHaveBeenCalled();
    });

    it('should propagate the error and not sign in when AuthService.logInAccount fails', async () => {
      // Arrange
      const error = new Error('Invalid credentials');
      authService.logInAccount.mockRejectedValue(error);

      // Act & Assert
      await expect(controller.loginUser(body)).rejects.toBe(error);
      expect(signInService.signIn).not.toHaveBeenCalled();
    });

    it('should propagate the error when signing in fails', async () => {
      // Arrange
      const error = new Error('sign in failed');
      authService.logInAccount.mockResolvedValue(buildUser());
      signInService.signIn.mockRejectedValue(error);

      // Act & Assert
      await expect(controller.loginUser(body)).rejects.toBe(error);
    });
  });
});
