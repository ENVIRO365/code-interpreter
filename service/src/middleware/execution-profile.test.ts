import { afterEach, describe, expect, test } from 'bun:test';
import type { NextFunction, Request, Response } from 'express';
import { env } from '../config';
import { executionProfileMiddleware } from './execution-profile';

const savedProfile = env.EXECUTION_PROFILE;

afterEach(() => {
  env.EXECUTION_PROFILE = savedProfile;
});

function invoke(expectedProfile?: string): {
  headers: Record<string, string>;
  status?: number;
  body?: unknown;
  nextCalled: boolean;
} {
  const result: {
    headers: Record<string, string>;
    status?: number;
    body?: unknown;
    nextCalled: boolean;
  } = { headers: {}, nextCalled: false };
  const req = {
    get: () => expectedProfile,
  } as unknown as Request;
  const res = {
    setHeader: (name: string, value: string) => {
      result.headers[name] = value;
    },
    status: (status: number) => {
      result.status = status;
      return res;
    },
    json: (body: unknown) => {
      result.body = body;
      return res;
    },
  } as unknown as Response;
  const next = (() => {
    result.nextCalled = true;
  }) as NextFunction;

  executionProfileMiddleware(req, res, next);
  return result;
}

describe('execution profile middleware', () => {
  test('advertises the actual profile and allows matching requests', () => {
    env.EXECUTION_PROFILE = 'stateful';
    expect(invoke('stateful')).toEqual({
      headers: { 'X-CodeAPI-Execution-Profile': 'stateful' },
      nextCalled: true,
    });
  });

  test('rejects a mismatched endpoint before routing', () => {
    env.EXECUTION_PROFILE = 'default';
    expect(invoke('stateful')).toMatchObject({
      headers: { 'X-CodeAPI-Execution-Profile': 'default' },
      status: 409,
      body: {
        code: 'execution_profile_mismatch',
        expected_profile: 'stateful',
        actual_profile: 'default',
      },
      nextCalled: false,
    });
  });

  test('keeps older callers working when they omit the assertion', () => {
    env.EXECUTION_PROFILE = 'default';
    expect(invoke()).toEqual({
      headers: { 'X-CodeAPI-Execution-Profile': 'default' },
      nextCalled: true,
    });
  });
});
