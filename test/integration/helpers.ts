import { expect } from "vitest";
import { QuackClient } from "../../src";
import type { QuackQueryResult, QuackRow } from "../../src";

type Env = {
  process?: {
    env?: Record<string, string | undefined>;
  };
};

const env = (globalThis as unknown as Env).process?.env ?? {};

export const integrationUrl = env.QUACK_INTEGRATION_URL;
export const authToken = env.QUACK_AUTH_TOKEN ?? "super_secret";

export async function connect(): Promise<QuackClient> {
  if (!integrationUrl) {
    throw new Error("QUACK_INTEGRATION_URL is not set");
  }
  return QuackClient.connect(integrationUrl, { authToken });
}

export async function withClient<T>(fn: (client: QuackClient) => Promise<T>): Promise<T> {
  const client = await connect();
  try {
    return await fn(client);
  } finally {
    await client.disconnect();
  }
}

export async function rows(sql: string): Promise<QuackRow[]> {
  return withClient(async (client) => (await client.query(sql)).rows());
}

export async function result(sql: string): Promise<QuackQueryResult> {
  return withClient((client) => client.query(sql));
}

export function expectRows(actual: QuackRow[], expected: QuackRow[]): void {
  expect(actual).toEqual(expected);
}

export function uniqueName(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.floor(Math.random() * 1_000_000)}`;
}

export function daysSinceEpoch(date: string): number {
  return Math.trunc(Date.parse(`${date}T00:00:00.000Z`) / 86_400_000);
}

export function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

export function bytes(value: number[]): Uint8Array {
  return new Uint8Array(value);
}

export function assertIntegrationConfigured(): void {
  if (!integrationUrl) {
    throw new Error("Integration tests require QUACK_INTEGRATION_URL");
  }
}
