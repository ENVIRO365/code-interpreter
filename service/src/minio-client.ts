import { Client, type ClientOptions } from 'minio';
import { defaultProvider } from '@aws-sdk/credential-provider-node';
import logger from './fileServerLogger';

type CredentialProviderCtor = new (opts: { accessKey: string; secretKey: string; sessionToken?: string }) => unknown;
type CredentialProviderModule = { CredentialProvider?: CredentialProviderCtor; default?: CredentialProviderCtor };

/** minio's own `CredentialProvider` class exists at runtime but isn't exported
 * from the package's main module. Try multiple import paths for compatibility
 * with different runtimes (bun, ts-node, node). */
async function loadMinioCredentialProvider(): Promise<CredentialProviderCtor> {
  try {
    const mod = await import('minio/dist/main/CredentialProvider.js') as CredentialProviderModule;
    return (mod.CredentialProvider ?? mod.default)!;
  } catch (primaryError) {
    try {
      // Fallback for bun: resolve path using require if available (CJS context)
      let resolvePath = 'node_modules/minio/';
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        resolvePath = require.resolve('minio').replace(/dist\/.*$/, '');
      } catch {
        // require.resolve not available (ESM context), use default path
      }
      const mod = await import(`${resolvePath}dist/main/CredentialProvider.js`) as CredentialProviderModule;
      return (mod.CredentialProvider ?? mod.default)!;
    } catch (fallbackError) {
      logger.error('Failed to load minio CredentialProvider', { primaryError, fallbackError });
      throw new Error('Could not load CredentialProvider from minio. Ensure minio >= 8.0.5 is installed.');
    }
  }
}

export async function createMinioClient(): Promise<Client> {
  const irsaExplicit = process.env.MINIO_USE_IRSA?.toLowerCase() === 'true';
  const irsaEnvVars = Boolean(process.env.AWS_WEB_IDENTITY_TOKEN_FILE) && Boolean(process.env.AWS_ROLE_ARN);
  const useIrsa = irsaExplicit || irsaEnvVars;

  const baseConfig: ClientOptions = {
    // Unknown-length streams otherwise grow SDK parts to 528 MiB (the 5 TiB
    // object limit / 10,000 parts). Bound each multipart buffer instead.
    partSize: 8 * 1024 * 1024,
    endPoint: process.env.MINIO_ENDPOINT ?? 'localhost',
    port: process.env.MINIO_NO_PORT?.toLowerCase() === 'true' ? undefined : parseInt(process.env.MINIO_PORT ?? '9000'),
    useSSL: process.env.MINIO_USE_SSL?.toLowerCase() === 'true',
    region: process.env.MINIO_REGION ?? process.env.AWS_REGION ?? 'us-east-1',
  };

  if (useIrsa) {
    /* Delegate credential resolution to the AWS SDK's own default provider
     * chain instead of minio's bundled `IamAwsProvider`. IamAwsProvider only
     * reads a static `AWS_CONTAINER_AUTHORIZATION_TOKEN` env var for the
     * container-credentials flow; it never reads
     * `AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE`, which is how EKS Pod Identity
     * (as opposed to IRSA) supplies and rotates its token. Without that
     * header the Pod Identity Agent rejects the request and minio fails
     * trying to JSON.parse its (non-JSON) error body. `fromNodeProviderChain`
     * is the same officially-maintained resolver already used elsewhere in
     * this service (see runtime-session/checkpoint-store.ts) and correctly
     * supports IRSA, EKS Pod Identity, ECS and EC2 IMDS, including token
     * rotation. */
    logger.info('Using AWS SDK default credential provider chain for S3 authentication', {
      region: baseConfig.region,
    });

    const CredentialProvider = await loadMinioCredentialProvider();
    const awsCredentialProvider = defaultProvider();

    const credentialsProvider = {
      getCredentials: async () => {
        const creds = await awsCredentialProvider();
        return new CredentialProvider({
          accessKey: creds.accessKeyId,
          secretKey: creds.secretAccessKey,
          sessionToken: creds.sessionToken,
        });
      },
    };

    return new Client({
      ...baseConfig,
      credentialsProvider: credentialsProvider as ClientOptions['credentialsProvider'],
    });
  }

  logger.info('Using explicit credentials for MinIO/S3 authentication');
  return new Client({
    ...baseConfig,
    accessKey: process.env.MINIO_ACCESS_KEY ?? '',
    secretKey: process.env.MINIO_SECRET_KEY ?? '',
    sessionToken: process.env.MINIO_SESSION_TOKEN,
  });
}

