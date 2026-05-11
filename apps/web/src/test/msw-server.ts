import { setupServer } from 'msw/node';

export const server = setupServer();
export { http, HttpResponse } from 'msw';
