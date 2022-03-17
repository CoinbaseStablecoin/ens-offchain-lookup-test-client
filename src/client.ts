import { BytesLike, ethers } from "ethers";
import {
  CoinbaseResolver__factory,
  ENSRegistryWithFallback__factory,
  IAddrResolver__factory,
  IResolverService__factory,
} from "./types/contracts";
import * as dnsname from "./dnsname";
import fetch from "node-fetch";

const iAddrResolver = IAddrResolver__factory.createInterface();
const iCoinbaseResolver = CoinbaseResolver__factory.createInterface();
const iResolverService = IResolverService__factory.createInterface();

async function main() {
  const { JSON_RPC_URL, REGISTRY_ADDRESS } = process.env;

  if (!JSON_RPC_URL) {
    throw new Error("env var JSON_RPC_URL is required");
  }

  if (!REGISTRY_ADDRESS) {
    throw new Error("env var REGISTRY_ADDRESS is required");
  }

  const name = process.argv[2];

  if (!name) {
    throw new Error("name not provided");
  }

  console.log(`Looking up ${name}...`);

  const provider = new ethers.providers.JsonRpcProvider(JSON_RPC_URL);

  const labels = name.split(".");

  const ensRegistry = ENSRegistryWithFallback__factory.connect(
    REGISTRY_ADDRESS,
    provider
  );

  let resolverAddress: string | undefined;

  for (let i = 0; i < labels.length; i++) {
    const subname = labels.slice(i).join(".");
    process.stdout.write(`Finding resolver contract address for ${subname}...`);
    const node = ethers.utils.namehash(subname);

    resolverAddress = await ensRegistry.resolver(node);

    if (resolverAddress !== ethers.constants.AddressZero) {
      console.log(`found - ${resolverAddress}`);
      break;
    }
    console.log("not found");
  }
  if (!resolverAddress || resolverAddress === ethers.constants.AddressZero) {
    throw new Error("could not find resolver contract address");
  }

  console.log(`Calling "resolve" on the resolver contract...`);

  const resolver = CoinbaseResolver__factory.connect(resolverAddress, provider);
  const encodedName = dnsname.encode(name);

  const addrCallData = iAddrResolver.encodeFunctionData("addr", [
    ethers.utils.namehash(name),
  ]);
  const resolveCallData = iCoinbaseResolver.encodeFunctionData("resolve", [
    encodedName,
    addrCallData,
  ]);

  let gatewayUrl: string | undefined;

  try {
    await resolver.resolve(encodedName, addrCallData);
  } catch (err: any) {
    if (err?.errorName !== "OffchainLookup") {
      throw new Error("expected OffchainLookup error");
    }

    const errorArgs:
      | {
          sender?: string;
          urls?: string[];
          callData?: string;
          callbackFunction?: string;
          extraData?: string;
        }
      | undefined = err?.errorArgs;

    console.log(`OffchainLookup received: ${JSON.stringify(errorArgs)}`);
    gatewayUrl = errorArgs?.urls?.at(0);

    if (errorArgs?.callData != resolveCallData) {
      throw new Error(
        `the "callData" in the OffchainLookup error does not match the expected data`
      );
    }
  }

  if (!gatewayUrl) {
    throw new Error("could not find offchain lookup url");
  }

  const requestUrl = gatewayUrl
    .replace("{sender}", resolverAddress)
    .replace("{data}", resolveCallData);

  console.log(`Requesting GET ${requestUrl}...`);

  const response = await fetch(requestUrl);
  const responseJson = await response.json();

  console.log(`Response received: ${JSON.stringify(responseJson)}`);

  const data: string | undefined = responseJson?.data;

  if (typeof data !== "string" || !ethers.utils.isHexString(data)) {
    throw new Error("response did not contain data");
  }

  const decodedData = iResolverService.decodeFunctionResult(
    "resolve",
    data
  ) as unknown as {
    result?: string;
    expires?: ethers.BigNumber;
    sig?: string;
  };

  if (!ethers.utils.isHexString(decodedData.result)) {
    throw new Error(`response data did not include a valid "result" value`);
  }
  if (!ethers.BigNumber.isBigNumber(decodedData.expires)) {
    throw new Error(`response data did not include a valid "expires" value`);
  }
  if (!ethers.utils.isHexString(decodedData.sig)) {
    throw new Error(`response data did not include a valid "sig" value`);
  }

  const expires = decodedData.expires!.toNumber();

  const decodedResult = iAddrResolver.decodeFunctionResult(
    "addr",
    decodedData.result!
  );

  console.log(`Decoded result: ${decodedResult}`);
  console.log(`Signature: ${decodedData.sig}`);
  console.log(`Expires at: ${new Date(expires * 1000)} (${expires})`);

  process.stdout.write("Verifying the response with the resolver contract...");

  let verifiedResult: string;
  try {
    verifiedResult = await resolver.resolveWithProof(data, resolveCallData);
  } catch (err) {
    console.log("failed!");
    throw err;
  }

  console.log("verified!");
  const decodedVerifiedResult = iAddrResolver.decodeFunctionResult(
    "addr",
    verifiedResult
  );
  console.log(`Verified result: ${decodedVerifiedResult}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
