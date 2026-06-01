// Test environment stub — sets all required env vars before any module loads.
// Values are non-functional placeholders sufficient for schema validation.

process.env.MODE = 'test';
process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
process.env.GMAIL_USER = 'test@example.com';
process.env.GMAIL_APP_PASSWORD = 'test-password';
process.env.GOOGLE_CLIENT_ID = 'test-google-client-id';
process.env.GOOGLE_CLIENT_SECRET = 'test-google-client-secret';
process.env.BACKEND_URL = 'http://localhost:3000';
process.env.FRONTEND_URL = 'http://localhost:5173';
process.env.CLOUDINARY_CLOUD_NAME = 'test-cloud';
process.env.CLOUDINARY_API_KEY = 'test-api-key';
process.env.CLOUDINARY_API_SECRET = 'test-api-secret';
process.env.PAYSTACK_SECRET_KEY = 'test-paystack-secret';
process.env.APP_SECRET = 'accesslayer_test_secret_key_32_bytes_long_xxxx';
