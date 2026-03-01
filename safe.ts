/**
 * Safe + SpendInteractor onboarding helper.
 *
 * Atomic deployment sequence for a new user:
 *   1. Predict the Safe address (deterministic CREATE2)
 *   2. Deploy SpendInteractor (avatar = predictedSafe, owner = admin)
 *   3. Deploy Safe with owners=[admin], threshold=1
 *   4. Execute Safe tx: enableModule(spendInteractorAddress)
 *   5. Execute Safe tx: addOwnerWithThreshold(userAddress, 2)
 *      → Safe is now 2/2, module enabled, admin retains SpendInteractor ownership
 *         so registerEOA() can be called directly without Safe sigs.
 *
 * Env vars:
 *   ADMIN_PRIVATE_KEY  - 0x-prefixed private key (admin = 2nd Safe owner + gas payer)
 *   RPC_URL            - HTTP JSON-RPC endpoint
 *   CHAIN_ID           - Chain ID (default: 10143 for monad-testnet)
 */

import Safe, {
  type PredictedSafeProps,
  type SafeAccountConfig,
} from "@safe-global/protocol-kit";
import { createPublicClient, createWalletClient, http, type Chain } from "viem";
import { privateKeyToAccount } from "viem/accounts";

// ─── SpendInteractor ABI (only what we need) ──────────────────────────────────

export const SPEND_INTERACTOR_ABI = [
  {
    type: "constructor",
    inputs: [
      { name: "_avatar", type: "address" },
      { name: "_owner", type: "address" },
    ],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "registerEOA",
    inputs: [
      { name: "eoa", type: "address" },
      { name: "dailyLimit", type: "uint256" },
      { name: "allowedTypes", type: "uint8[]" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "revokeEOA",
    inputs: [{ name: "eoa", type: "address" }],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "updateLimit",
    inputs: [
      { name: "eoa", type: "address" },
      { name: "newDailyLimit", type: "uint256" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "getRegisteredEOAs",
    inputs: [],
    outputs: [{ name: "", type: "address[]" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "isRegisteredEOA",
    inputs: [{ name: "eoa", type: "address" }],
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "getDailyLimit",
    inputs: [{ name: "eoa", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "getRemainingLimit",
    inputs: [{ name: "eoa", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "getAllowedTypesBitmap",
    inputs: [{ name: "eoa", type: "address" }],
    outputs: [{ name: "", type: "uint8" }],
    stateMutability: "view",
  },
] as const;

// ─── Helpers ──────────────────────────────────────────────────────────────────

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

async function loadBytecode(): Promise<`0x${string}`> {
  const { readFile } = await import("fs/promises");
  const { resolve } = await import("path");
  const { fileURLToPath } = await import("url");

  const dir = fileURLToPath(new URL(".", import.meta.url));
  const artifactPath = resolve(dir, "SpendInteractor.json");
  const artifact = JSON.parse(await readFile(artifactPath, "utf8"));
  return artifact.bytecode.object as `0x${string}`;
}

// ─── Main export ──────────────────────────────────────────────────────────────

export type DeployResult = {
  safeAddress: string;
  spendInteractorAddress: string;
};

export async function deployUserSafe(
  userAddress: string,
): Promise<DeployResult> {
  const adminPrivateKey = getAdminPrivateKey();
  const adminAccount = privateKeyToAccount(adminPrivateKey);
  const rpcUrl = process.env.RPC_URL!;
  const chain = getChain();

  const walletClient = createWalletClient({
    account: adminAccount,
    transport: http(rpcUrl),
    chain,
  });
  const publicClient = createPublicClient({ transport: http(rpcUrl), chain });

  // ── Step 1: predict Safe address ────────────────────────────────────────────

  const safeAccountConfig: SafeAccountConfig = {
    owners: [adminAccount.address],
    threshold: 1,
  };
  // Use the user address as the salt so each user gets a unique Safe address
  const saltNonce = BigInt(userAddress.toLowerCase()).toString();
  const predictedSafe: PredictedSafeProps = {
    safeAccountConfig,
    safeDeploymentConfig: { saltNonce },
  };

  const protocolKit = await Safe.init({
    provider: rpcUrl,
    signer: adminPrivateKey,
    predictedSafe,
  });

  const safeAddress = await protocolKit.getAddress();

  // Safe already on-chain: a previous run crashed mid-sequence.
  // Re-init against the deployed Safe and resume from the failed step.
  if (await protocolKit.isSafeDeployed()) {
    console.log(
      `[safe] Safe already deployed at ${safeAddress} for ${userAddress} — resuming setup`,
    );

    const safeSdk = await Safe.init({
      provider: rpcUrl,
      signer: adminPrivateKey,
      safeAddress,
    });

    // Step 4 check: is a module already enabled?
    const modules = await safeSdk.getModules();
    let spendInteractorAddress: string;

    if (modules.length > 0) {
      // enableModule already ran — use the existing module address
      spendInteractorAddress = modules[0];
      console.log(
        `[safe] SpendInteractor already enabled: ${spendInteractorAddress}`,
      );
    } else {
      // SpendInteractor was never enabled (or was deployed but orphaned) — re-deploy
      console.log(`[safe] No module found — re-deploying SpendInteractor`);
      const bytecode = await loadBytecode();
      const deployTxHash = await walletClient.deployContract({
        abi: SPEND_INTERACTOR_ABI,
        bytecode,
        args: [safeAddress as `0x${string}`, adminAccount.address],
      });
      const deployReceipt = await publicClient.waitForTransactionReceipt({
        hash: deployTxHash,
      });
      if (!deployReceipt.contractAddress)
        throw new Error("SpendInteractor re-deploy failed");
      spendInteractorAddress = deployReceipt.contractAddress;
      console.log(
        `[safe] SpendInteractor re-deployed at ${spendInteractorAddress}`,
      );

      const enableModuleTx = await safeSdk.createEnableModuleTx(
        spendInteractorAddress,
      );
      const signedEnableModuleTx =
        await safeSdk.signTransaction(enableModuleTx);
      const enableResult =
        await safeSdk.executeTransaction(signedEnableModuleTx);
      await publicClient.waitForTransactionReceipt({
        hash: enableResult.hash as `0x${string}`,
      });
      console.log(`[safe] SpendInteractor module enabled on Safe`);
    }

    // Step 5 check: is the user already an owner?
    const owners = await safeSdk.getOwners();
    if (
      !owners.map((o) => o.toLowerCase()).includes(userAddress.toLowerCase())
    ) {
      const addOwnerTx = await safeSdk.createAddOwnerTx({
        ownerAddress: userAddress,
        threshold: 2,
      });
      const signedAddOwnerTx = await safeSdk.signTransaction(addOwnerTx);
      const addOwnerResult = await safeSdk.executeTransaction(signedAddOwnerTx);
      await publicClient.waitForTransactionReceipt({
        hash: addOwnerResult.hash as `0x${string}`,
      });
      console.log(
        `[safe] User ${userAddress} added as owner, threshold set to 2`,
      );
    } else {
      console.log(`[safe] User ${userAddress} already an owner`);
    }

    return { safeAddress, spendInteractorAddress };
  }

  console.log(`[safe] Predicted Safe address: ${safeAddress}`);

  // ── Step 2: deploy SpendInteractor (avatar=safe, owner=admin) ───────────────

  const bytecode = await loadBytecode();

  const deployTxHash = await walletClient.deployContract({
    abi: SPEND_INTERACTOR_ABI,
    bytecode,
    args: [safeAddress as `0x${string}`, adminAccount.address],
  });

  const deployReceipt = await publicClient.waitForTransactionReceipt({
    hash: deployTxHash,
  });

  const spendInteractorAddress = deployReceipt.contractAddress;
  if (!spendInteractorAddress)
    throw new Error(
      "SpendInteractor deployment failed — no contract address in receipt",
    );

  console.log(`[safe] SpendInteractor deployed at ${spendInteractorAddress}`);

  // ── Step 3: deploy Safe (owners=[admin], threshold=1) ───────────────────────

  const deploymentTx = await protocolKit.createSafeDeploymentTransaction();

  const safeTxHash = await walletClient.sendTransaction({
    to: deploymentTx.to as `0x${string}`,
    value: BigInt(deploymentTx.value),
    data: deploymentTx.data as `0x${string}`,
  });

  await publicClient.waitForTransactionReceipt({ hash: safeTxHash });

  console.log(`[safe] Safe deployed at ${safeAddress}`);

  // ── Steps 4 & 5: enableModule + addOwnerWithThreshold via Protocol Kit ──────

  // Re-init against the now-deployed Safe (predictedSafe mode can't sign/execute)
  const safeSdk = await Safe.init({
    provider: rpcUrl,
    signer: adminPrivateKey,
    safeAddress,
  });

  // enableModule(spendInteractorAddress)
  const enableModuleTx = await safeSdk.createEnableModuleTx(
    spendInteractorAddress,
  );
  const signedEnableModuleTx = await safeSdk.signTransaction(enableModuleTx);
  const enableResult = await safeSdk.executeTransaction(signedEnableModuleTx);
  await publicClient.waitForTransactionReceipt({
    hash: enableResult.hash as `0x${string}`,
  });

  console.log(`[safe] SpendInteractor module enabled on Safe`);

  // addOwnerWithThreshold(userAddress, 2) — atomically adds user + raises threshold
  const addOwnerTx = await safeSdk.createAddOwnerTx({
    ownerAddress: userAddress,
    threshold: 2,
  });
  const signedAddOwnerTx = await safeSdk.signTransaction(addOwnerTx);
  const addOwnerResult = await safeSdk.executeTransaction(signedAddOwnerTx);
  await publicClient.waitForTransactionReceipt({
    hash: addOwnerResult.hash as `0x${string}`,
  });

  console.log(`[safe] User ${userAddress} added as owner, threshold set to 2`);

  return { safeAddress, spendInteractorAddress };
}
