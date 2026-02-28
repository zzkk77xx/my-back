/**
 * Safe multisig deployment helper.
 *
 * Deploys a 2/2 Safe for a new user using the Safe Protocol Kit.
 * Owners: [userAddress, ADMIN_ADDRESS derived from ADMIN_PRIVATE_KEY]
 * Threshold: 2
 *
 * Env vars:
 *   ADMIN_PRIVATE_KEY - 0x-prefixed private key of the admin (co-owner + gas payer)
 *   RPC_URL           - HTTP JSON-RPC endpoint
 *   CHAIN_ID          - Chain ID (default: 10143 for monad-testnet)
 */

import Safe, {
  type PredictedSafeProps,
  type SafeAccountConfig,
} from "@safe-global/protocol-kit";
import { type Chain, privateKeyToAccount } from "viem/accounts";

const CHAIN_ID = Number(process.env.CHAIN_ID ?? 10143);

function getAdminPrivateKey(): `0x${string}` {
  const key = process.env.ADMIN_PRIVATE_KEY;
  if (!key) throw new Error("ADMIN_PRIVATE_KEY env var is required");
  return key as `0x${string}`;
}

function getChain(): Chain {
  const rpcUrl = process.env.RPC_URL;
  if (!rpcUrl) throw new Error("RPC_URL env var is required");
  return {
    id: CHAIN_ID,
    name: "monad-testnet",
    nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  };
}

/**
 * Deploy a 2/2 Safe for a user.
 * Returns the deterministic Safe address (same result if called twice with the same userAddress).
 */
export async function deployUserSafe(
  userAddress: string
): Promise<{ safeAddress: string; alreadyExists: boolean }> {
  const adminPrivateKey = getAdminPrivateKey();
  const adminAddress = privateKeyToAccount(adminPrivateKey).address;
  const rpcUrl = process.env.RPC_URL!;

  const safeAccountConfig: SafeAccountConfig = {
    owners: [userAddress, adminAddress],
    threshold: 2,
  };

  const predictedSafe: PredictedSafeProps = { safeAccountConfig };

  // Initialize Protocol Kit in "predicted" mode to get the deterministic address
  const protocolKit = await Safe.init({
    provider: rpcUrl,
    signer: adminPrivateKey,
    predictedSafe,
  });

  const safeAddress = await protocolKit.getAddress();
  const alreadyDeployed = await protocolKit.isSafeDeployed();

  if (alreadyDeployed) {
    return { safeAddress, alreadyExists: true };
  }

  console.log(`[safe] Deploying 2/2 Safe for ${userAddress} at ${safeAddress} ...`);

  // Build the deployment transaction
  const deploymentTx = await protocolKit.createSafeDeploymentTransaction();

  // Execute via the viem signer the Protocol Kit manages
  const client = await protocolKit.getSafeProvider().getExternalSigner();
  if (!client) throw new Error("Could not obtain external signer from Protocol Kit");

  const chain = getChain();

  const txHash = await client.sendTransaction({
    to: deploymentTx.to as `0x${string}`,
    value: BigInt(deploymentTx.value),
    data: deploymentTx.data as `0x${string}`,
    chain,
  });

  await client.waitForTransactionReceipt({ hash: txHash });

  console.log(`[safe] Safe deployed at ${safeAddress} (tx: ${txHash})`);

  return { safeAddress, alreadyExists: false };
}
