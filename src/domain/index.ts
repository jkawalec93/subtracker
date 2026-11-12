/**
 * Pure domain layer entry point.
 * Must stay completely free of I/O, database, server, and UI imports.
 */
export const DOMAIN_VERSION = '1.0.0-mvp';

export * from './types';
export * from './dates';
export * from './pricing';
export * from './payment-methods';
export * from './scheduler';
export * from './alerts';
