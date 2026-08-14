type RegisterUploadSession = (sessionKey: string) => Promise<unknown>;

/**
 * Creates a request-scoped session registrar. Every file shares the first
 * registration promise, allowing callers to wait for the Redis write without
 * issuing duplicate SETs for a batch.
 */
export function createUploadSessionRegistrar(
  registerSession: RegisterUploadSession,
): (sessionKey: string) => Promise<unknown> {
  let sessionRegistered: Promise<unknown> | undefined;

  return (sessionKey: string): Promise<unknown> => {
    sessionRegistered ??= registerSession(sessionKey);
    return sessionRegistered;
  };
}
