const request = require('supertest');
const jwt = require('jsonwebtoken');

// Mock external problematic ESM modules
jest.mock('uuid', () => ({ v4: () => 'mock-uuid-1234' }));

const app = require('../../src/index');
const { pool } = require('../../src/db');

// Mock the pg pool and db init
jest.mock('../../src/db', () => {
  return {
    initializeDatabase: jest.fn().mockResolvedValue(true),
    pool: { query: jest.fn() },
    query: jest.fn()
  };
});

describe('Auth Service - API Endpoints', () => {
  
  beforeEach(() => {
    // Reset mock queues before each test
    pool.query.mockReset();
  });

  describe('POST /api/auth/register', () => {
    it('should return 400 if email is missing', async () => {
      const resp = await request(app)
        .post('/api/auth/register')
        .send({ password: 'testpassword' });
        
      expect(resp.status).toBe(400);
      expect(resp.body).toHaveProperty('error');
    });

    it('should return 409 if user already exists', async () => {
      // Mock db throwing unique violation
      pool.query.mockRejectedValueOnce({ code: '23505' }); 
      
      const resp = await request(app)
        .post('/api/auth/register')
        .send({ email: 'test@test.com', password: 'testpassword' });
        
      expect(resp.status).toBe(409);
      expect(resp.body.error).toMatch(/already registered/);
    });

    it('should return 201 on successful registration', async () => {
      // 1. Insert user
      pool.query.mockResolvedValueOnce({ rows: [{ id: 1, email: 'new@test.com' }] });

      const resp = await request(app)
        .post('/api/auth/register')
        .send({ email: 'new@test.com', password: 'password123' });

      expect(resp.status).toBe(201);
      expect(resp.body.message).toBe('User registered successfully');
      expect(resp.body.user.email).toBe('new@test.com');
    });
  });

  describe('POST /api/auth/login', () => {
    it('should return 401 on invalid email', async () => {
      // No user found in DB
      pool.query.mockResolvedValueOnce({ rows: [] }); 

      const resp = await request(app)
        .post('/api/auth/login')
        .send({ email: 'wrong@test.com', password: 'password123' });

      expect(resp.status).toBe(401);
    });
    
    // We intentionally ignore passing the bcrypt check for unit testing 
    // unless we mock bcrypt, which we can add later if required.
  });
});
