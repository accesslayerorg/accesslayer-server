import express from 'express';
import { envConfig } from '../config';

/**
 * Creates JSON and URL-encoded body parsers with a specific size limit.
 * 
 * @param limit The maximum body size (e.g., '1mb', '10mb')
 */
export const createBodyParser = (limit: string) => {
   return [
      express.json({ limit }),
      express.urlencoded({ extended: true, limit })
   ];
};

/**
 * Default body parser limit used by most routes.
 */
export const defaultBodyParser = createBodyParser(envConfig.MAX_BODY_SIZE_DEFAULT);

/**
 * Admin route body parser with higher limits for bulk operations.
 */
export const adminBodyParser = createBodyParser(envConfig.MAX_BODY_SIZE_ADMIN);

/**
 * Creators route body parser with specific limits for creator operations.
 */
export const creatorsBodyParser = createBodyParser(envConfig.MAX_BODY_SIZE_CREATORS);
