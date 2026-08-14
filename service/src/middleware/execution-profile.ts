import type { NextFunction, Request, Response } from 'express';
import { env } from '../config';
import {
  checkExecutionProfileExpectation,
  EXECUTION_PROFILE_HEADER,
  EXPECTED_EXECUTION_PROFILE_HEADER,
} from '../execution-profile';
import { executionProfileRequestRejections } from '../metrics';

/**
 * Advertise this deployment's profile and fail closed when a trusted caller
 * reaches the wrong endpoint. Apply before routing so no file, programmatic,
 * or ordinary execution request can enqueue work on a mismatched stack.
 */
export function executionProfileMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  res.setHeader(EXECUTION_PROFILE_HEADER, env.EXECUTION_PROFILE);

  const expectation = checkExecutionProfileExpectation(
    req.get(EXPECTED_EXECUTION_PROFILE_HEADER),
    env.EXECUTION_PROFILE,
  );
  if (expectation.ok) {
    next();
    return;
  }

  executionProfileRequestRejections.inc({
    reason: expectation.body.code === 'execution_profile_mismatch'
      ? 'mismatch'
      : 'invalid',
  });
  res.status(expectation.status).json(expectation.body);
}
