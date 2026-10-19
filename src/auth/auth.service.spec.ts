import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { getDrizzleToken } from '@nestjs/drizzle';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { Mock, MockedFunction } from 'vitest';
import { AuthService } from './auth.service.js';
import { CredentialService } from '../shared/services/credentials.js';
import { userTable, type User } from '../db/schemas/user.js';

const buildUser = (overrides: Partial<User> = {}): User => ({
  id: '00000000-0000-0000-0000-000000000000',
  name: 'Test User',
  email: 'test@example.com',
  emailVerified: false,
  passwordHash: 'hashed-password',
  loginProvider: 'LOCAL',
  ...overrides,
});

interface DbMock {
  select: Mock;
  from: Mock;
  where: Mock;
  insert: Mock;
  values: Mock;
}

const createDbMock = (): DbMock => {
  const db = {
    select: vi.fn(),
    from: vi.fn(),
    where: vi.fn(),
    insert: vi.fn(),
    values: vi.fn(),
  } as unknown as DbMock;

  db.select.mockReturnValue(db);
  db.from.mockReturnValue(db);
  db.insert.mockReturnValue(db);

  return db;
};

const createCredentialsMock = () => ({
  hashPassword: vi.fn() as unknown as MockedFunction<
    CredentialService['hashPassword']
  >,
  comparePassword: vi.fn() as unknown as MockedFunction<
    CredentialService['comparePassword']
  >,
});

describe('AuthService', () => {
  let service: AuthService;
  let db: DbMock;
  let credentials: ReturnType<typeof createCredentialsMock>;

  beforeEach(async () => {
    db = createDbMock();
    db.where.mockResolvedValue([]);
    db.values.mockResolvedValue(undefined);
    credentials = createCredentialsMock();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        {
          provide: getDrizzleToken(),
          useValue: db as unknown as NodePgDatabase,
        },
        {
          provide: CredentialService,
          useValue: credentials,
        },
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('createAccount', () => {
    const payload = {
      email: 'new@example.com',
      name: 'New User',
      password: 'plain-password',
    };

    it('should hash the password and insert the new user when the email is free', async () => {
      // Arrange
      db.where.mockResolvedValue([]);
      credentials.hashPassword.mockResolvedValue('hashed-password');

      // Act
      const result = await service.createAccount(payload);

      // Assert
      expect(result).toBeUndefined();
      expect(credentials.hashPassword).toHaveBeenCalledWith('plain-password');
      expect(db.insert).toHaveBeenCalledWith(userTable);
      expect(db.values).toHaveBeenCalledWith({
        email: 'new@example.com',
        name: 'New User',
        emailVerified: false,
        loginProvider: 'LOCAL',
        passwordHash: 'hashed-password',
      });
    });

    it('should look up the user table by email before inserting', async () => {
      // Arrange
      credentials.hashPassword.mockResolvedValue('hashed-password');

      // Act
      await service.createAccount(payload);

      // Assert
      expect(db.select).toHaveBeenCalledTimes(1);
      expect(db.from).toHaveBeenCalledWith(userTable);
      expect(db.where).toHaveBeenCalledTimes(1);
      expect(db.where).toHaveBeenCalledWith(expect.anything());
    });

    it('should throw ConflictException and not create the account when the email already exists', async () => {
      // Arrange
      db.where.mockResolvedValue([buildUser({ email: payload.email })]);

      // Act & Assert
      await expect(service.createAccount(payload)).rejects.toThrow(
        ConflictException,
      );
      expect(credentials.hashPassword).not.toHaveBeenCalled();
      expect(db.insert).not.toHaveBeenCalled();
      expect(db.values).not.toHaveBeenCalled();
    });

    it('should propagate the error and not insert when hashing the password fails', async () => {
      // Arrange
      const error = new Error('hashing failed');
      credentials.hashPassword.mockRejectedValue(error);

      // Act & Assert
      await expect(service.createAccount(payload)).rejects.toThrow(error);
      expect(db.insert).not.toHaveBeenCalled();
    });

    it('should propagate the error when the lookup query fails', async () => {
      // Arrange
      const error = new Error('query failed');
      db.where.mockRejectedValue(error);

      // Act & Assert
      await expect(service.createAccount(payload)).rejects.toThrow(error);
      expect(credentials.hashPassword).not.toHaveBeenCalled();
      expect(db.insert).not.toHaveBeenCalled();
    });

    it('should pass empty string values through without validation', async () => {
      // Arrange
      credentials.hashPassword.mockResolvedValue('hashed-password');

      // Act
      await service.createAccount({ email: '', name: '', password: '' });

      // Assert
      expect(credentials.hashPassword).toHaveBeenCalledWith('');
      expect(db.values).toHaveBeenCalledWith(
        expect.objectContaining({
          email: '',
          name: '',
          passwordHash: 'hashed-password',
        }),
      );
    });
  });

  describe('logInAccount', () => {
    const payload = { email: 'test@example.com', password: 'plain-password' };

    it('should resolve when the credentials are valid', async () => {
      // Arrange
      db.where.mockResolvedValue([
        buildUser({ email: payload.email, passwordHash: 'hashed-password' }),
      ]);
      credentials.comparePassword.mockResolvedValue(true);

      // Act
      const result = await service.logInAccount(payload);

      // Assert
      expect(result).toBeUndefined();
      expect(credentials.comparePassword).toHaveBeenCalledWith(
        'plain-password',
        'hashed-password',
      );
    });

    it('should throw NotFoundException when no account matches the email', async () => {
      // Arrange
      db.where.mockResolvedValue([]);

      // Act & Assert
      await expect(service.logInAccount(payload)).rejects.toThrow(
        NotFoundException,
      );
      expect(credentials.comparePassword).not.toHaveBeenCalled();
    });

    it('should throw BadRequestException when the account has no password hash', async () => {
      // Arrange
      db.where.mockResolvedValue([
        buildUser({ email: payload.email, passwordHash: null }),
      ]);

      // Act & Assert
      await expect(service.logInAccount(payload)).rejects.toThrow(
        BadRequestException,
      );
      expect(credentials.comparePassword).not.toHaveBeenCalled();
    });

    it('should throw BadRequestException when the password hash is an empty string', async () => {
      // Arrange
      db.where.mockResolvedValue([
        buildUser({ email: payload.email, passwordHash: '' }),
      ]);

      // Act & Assert
      await expect(service.logInAccount(payload)).rejects.toThrow(
        BadRequestException,
      );
      expect(credentials.comparePassword).not.toHaveBeenCalled();
    });

    it('should throw UnauthorizedException when the password does not match', async () => {
      // Arrange
      db.where.mockResolvedValue([
        buildUser({ email: payload.email, passwordHash: 'hashed-password' }),
      ]);
      credentials.comparePassword.mockResolvedValue(false);

      // Act & Assert
      await expect(service.logInAccount(payload)).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('should propagate the error when comparing the password fails', async () => {
      // Arrange
      const error = new Error('compare failed');
      db.where.mockResolvedValue([buildUser({ email: payload.email })]);
      credentials.comparePassword.mockRejectedValue(error);

      // Act & Assert
      await expect(service.logInAccount(payload)).rejects.toThrow(error);
    });

    it('should propagate the error when the lookup query fails', async () => {
      // Arrange
      const error = new Error('query failed');
      db.where.mockRejectedValue(error);

      // Act & Assert
      await expect(service.logInAccount(payload)).rejects.toThrow(error);
      expect(credentials.comparePassword).not.toHaveBeenCalled();
    });

    it('should use the first matching row when the query returns several rows', async () => {
      // Arrange
      db.where.mockResolvedValue([
        buildUser({ email: payload.email, passwordHash: 'first-hash' }),
        buildUser({ email: payload.email, passwordHash: 'second-hash' }),
      ]);
      credentials.comparePassword.mockResolvedValue(true);

      // Act
      await service.logInAccount(payload);

      // Assert
      expect(credentials.comparePassword).toHaveBeenCalledWith(
        'plain-password',
        'first-hash',
      );
    });
  });
});
