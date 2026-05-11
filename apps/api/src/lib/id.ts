import { ulid as makeUlid } from 'ulid';

export const ulid = (): string => makeUlid();
