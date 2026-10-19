import { Test, TestingModule } from '@nestjs/testing';
import type { MockedFunction } from 'vitest';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';

const createAuthServiceMock = () => ({
  createAccount: vi.fn() as unknown as MockedFunction<
    AuthService['createAccount']
  >,
  logInAccount: vi.fn() as unknown as MockedFunction<
    AuthService['logInAccount']
  >,
});

describe('AuthController', () => {
  let controller: AuthController;
  let authService: ReturnType<typeof createAuthServiceMock>;

  beforeEach(async () => {
    authService = createAuthServiceMock();

    const module: TestingModule = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [
        {
          provide: AuthService,
          useValue: authService,
        },
      ],
    }).compile();

    controller = module.get<AuthController>(AuthController);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('registerUser', () => {
    it('should delegate to AuthService.createAccount with the request body', async () => {
      // Arrange
      const body = {
        email: 'new@example.com',
        name: 'New User',
        password: 'plain-password',
      };
      authService.createAccount.mockResolvedValue(undefined);

      // Act
      const result = await controller.registerUser(body);

      // Assert
      expect(authService.createAccount).toHaveBeenCalledWith(body);
      expect(authService.createAccount).toHaveBeenCalledTimes(1);
      expect(result).toBeUndefined();
    });

    it('should propagate the error thrown by AuthService.createAccount', async () => {
      // Arrange
      const body = {
        email: 'taken@example.com',
        name: 'New User',
        password: 'plain-password',
      };
      const error = new Error('Email already exists');
      authService.createAccount.mockRejectedValue(error);

      // Act & Assert
      await expect(controller.registerUser(body)).rejects.toThrow(error);
    });
  });

  describe('loginUser', () => {
    it('should delegate to AuthService.logInAccount with the request body', async () => {
      // Arrange
      const body = { email: 'test@example.com', password: 'plain-password' };
      authService.logInAccount.mockResolvedValue(undefined);

      // Act
      const result = await controller.loginUser(body);

      // Assert
      expect(authService.logInAccount).toHaveBeenCalledWith(body);
      expect(authService.logInAccount).toHaveBeenCalledTimes(1);
      expect(result).toBeUndefined();
    });

    it('should propagate the error thrown by AuthService.logInAccount', async () => {
      // Arrange
      const body = { email: 'test@example.com', password: 'wrong-password' };
      const error = new Error('Invalid credentials');
      authService.logInAccount.mockRejectedValue(error);

      // Act & Assert
      await expect(controller.loginUser(body)).rejects.toThrow(error);
    });
  });
});
