import { z } from 'zod';

export const DealSchema = z.object({
  asin: z.string().regex(/^[A-Z0-9]{10}$/),
  title: z.string().min(1).max(500),
  category: z.string().optional(),
  imageUrl: z.string().url().optional(),
  productUrl: z.string().url(),
  rating: z.number().min(0).max(5).optional(),
  reviewCount: z.number().int().min(0).optional(),
  price: z.number().positive(),
  mrp: z.number().positive().optional(),
  source: z.enum(['amazon', 'whatsapp', 'api']).default('amazon'),
  discoveredAt: z.date().default(() => new Date()),
});

export const DealScoreSchema = z.object({
  asin: z.string(),
  score: z.number().min(0).max(10),
  factors: z.object({
    discountWeight: z.number(),
    historicalWeight: z.number(),
    ratingWeight: z.number(),
    socialWeight: z.number(),
  }),
  verdict: z.enum(['hot', 'good', 'average', 'skip']),
});

export const PostSchema = z.object({
  asin: z.string(),
  caption: z.string().min(1),
  imageUrl: z.string().url().optional(),
  affiliateUrl: z.string().url(),
  channel: z.string().default('telegram'),
  scheduledAt: z.date().optional(),
  metadata: z.object({
    dealScore: z.number(),
    template: z.string(),
    urgencyHook: z.string().optional(),
  }).optional(),
});

export default { DealSchema, DealScoreSchema, PostSchema };