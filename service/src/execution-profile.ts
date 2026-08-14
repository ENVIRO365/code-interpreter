export const EXECUTION_PROFILES = ['default', 'stateful'] as const;

export type ExecutionProfile = typeof EXECUTION_PROFILES[number];

export const EXPECTED_EXECUTION_PROFILE_HEADER = 'X-CodeAPI-Expected-Profile';
export const EXECUTION_PROFILE_HEADER = 'X-CodeAPI-Execution-Profile';

export interface ExecutionProfileQueueNames {
  python: string;
  other: string;
}

export function resolveExecutionProfile(
  raw: string | undefined,
  runtimeSessionMode: 'stateless' | 'affinity' | 'strict',
): ExecutionProfile {
  if (raw != null) {
    if (EXECUTION_PROFILES.includes(raw as ExecutionProfile)) {
      return raw as ExecutionProfile;
    }
    throw new Error(
      `CODEAPI_EXECUTION_PROFILE must be one of: ${EXECUTION_PROFILES.join(', ')}`,
    );
  }

  /* Preserve the two supported pre-profile deployments during rollout. The
   * common stateless stack remains `default`; a stateful API-only pod can
   * infer `stateful` from its session mode even though worker-only backend
   * credentials/config are intentionally absent. Worker startup separately
   * verifies that this profile is backed by Lambda. */
  return runtimeSessionMode !== 'stateless'
    ? 'stateful'
    : 'default';
}

export function queueNamesForExecutionProfile(
  profile: ExecutionProfile,
): ExecutionProfileQueueNames {
  if (profile === 'stateful') {
    return {
      python: 'stateful-python-queue',
      other: 'stateful-other-queue',
    };
  }
  return {
    python: 'python-queue',
    other: 'other-queue',
  };
}

export type ExecutionProfileExpectation =
  | { ok: true }
  | {
    ok: false;
    status: 400 | 409;
    body: {
      error: string;
      code: 'invalid_execution_profile' | 'execution_profile_mismatch';
      expected_profile?: string;
      actual_profile: ExecutionProfile;
    };
  };

export function checkExecutionProfileExpectation(
  rawExpectedProfile: string | undefined,
  actualProfile: ExecutionProfile,
): ExecutionProfileExpectation {
  if (rawExpectedProfile == null) return { ok: true };

  if (!EXECUTION_PROFILES.includes(rawExpectedProfile as ExecutionProfile)) {
    return {
      ok: false,
      status: 400,
      body: {
        error: `Invalid execution profile: ${rawExpectedProfile}`,
        code: 'invalid_execution_profile',
        expected_profile: rawExpectedProfile,
        actual_profile: actualProfile,
      },
    };
  }

  if (rawExpectedProfile !== actualProfile) {
    return {
      ok: false,
      status: 409,
      body: {
        error: `Expected the ${rawExpectedProfile} execution profile, but reached ${actualProfile}`,
        code: 'execution_profile_mismatch',
        expected_profile: rawExpectedProfile,
        actual_profile: actualProfile,
      },
    };
  }

  return { ok: true };
}
