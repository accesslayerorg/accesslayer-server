import supertest from 'supertest';
import app from '../../app';
import { prisma } from '../../utils/prisma.utils';

describe('GET /api/v1/creators/:id/holders sorting', () => {
  let creatorId: string;

  beforeAll(async () => {
    // Seed a creator
    const user = await prisma.user.create({
      data: {
        id: 'holder-sort-test-user',
        email: 'holder-sort-test@example.com',
        passwordHash: 'dummy-hash',
        firstName: 'Holder',
        lastName: 'SortTest',
      }
    });

    const creator = await prisma.creatorProfile.create({
      data: {
        userId: user.id,
        handle: 'holder-sort-creator',
        displayName: 'Holder Sort Creator',
      }
    });
    creatorId = creator.id;

    // Seed 3 holders with different held_since (createdAt) and key_balance
    await prisma.keyOwnership.createMany({
      data: [
        {
          ownerAddress: '0xabc1',
          creatorId: creator.id,
          balance: 10,
          createdAt: new Date('2024-01-01T00:00:00.000Z'), // Earliest buyer, smallest balance
        },
        {
          ownerAddress: '0xabc2',
          creatorId: creator.id,
          balance: 30,
          createdAt: new Date('2024-02-01T00:00:00.000Z'), // Middle buyer, largest balance
        },
        {
          ownerAddress: '0xabc3',
          creatorId: creator.id,
          balance: 20,
          createdAt: new Date('2024-03-01T00:00:00.000Z'), // Latest buyer, middle balance
        },
      ]
    });
  });

  afterAll(async () => {
    await prisma.keyOwnership.deleteMany({
      where: { creatorId }
    });
    await prisma.creatorProfile.delete({
      where: { id: creatorId }
    });
    await prisma.user.delete({
      where: { id: 'holder-sort-test-user' }
    });
    await prisma.$disconnect();
  });

  it('returns holders sorted by balance desc by default', async () => {
    const res = await supertest(app).get(`/api/v1/creators/${creatorId}/holders`);
    expect(res.status).toBe(200);

    const items = res.body.data.items;
    expect(items).toHaveLength(3);
    
    // Largest balance first: 30 (0xabc2), 20 (0xabc3), 10 (0xabc1)
    expect(items[0].wallet_address).toBe('0xabc2');
    expect(items[0].key_balance).toBe(30);
    
    expect(items[1].wallet_address).toBe('0xabc3');
    expect(items[1].key_balance).toBe(20);
    
    expect(items[2].wallet_address).toBe('0xabc1');
    expect(items[2].key_balance).toBe(10);
  });

  it('returns earliest buyer first when sort=held_since is passed', async () => {
    const res = await supertest(app).get(`/api/v1/creators/${creatorId}/holders?sort=held_since`);
    expect(res.status).toBe(200);

    const items = res.body.data.items;
    expect(items).toHaveLength(3);
    
    // Earliest buyer first: 2024-01-01 (0xabc1), 2024-02-01 (0xabc2), 2024-03-01 (0xabc3)
    expect(items[0].wallet_address).toBe('0xabc1');
    expect(items[0].held_since).toBe('2024-01-01T00:00:00.000Z');
    
    expect(items[1].wallet_address).toBe('0xabc2');
    expect(items[1].held_since).toBe('2024-02-01T00:00:00.000Z');
    
    expect(items[2].wallet_address).toBe('0xabc3');
    expect(items[2].held_since).toBe('2024-03-01T00:00:00.000Z');
  });
});
