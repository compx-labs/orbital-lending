import { algorandFixture } from "@algorandfoundation/algokit-utils/testing";
import { FluxGateFactory } from "./flux-gateClient";
import algosdk, { Account } from "algosdk";

export const deploy = async ({ deployer }: { deployer: Account }) => {
  const localnet = algorandFixture();
  await localnet.newScope(); // Ensure context is initialized before accessing it
  localnet.algorand.setSignerFromAccount(deployer);

  const factory = localnet.algorand.client.getTypedAppFactory(FluxGateFactory, {
    defaultSender: deployer.addr,
  });
  const { appClient } = await factory.send.create.createApplication({
    args: {
      admin: deployer.addr.toString(),
    },
    sender: deployer.addr,
    accountReferences: [deployer.addr],
  });
  appClient.algorand.setSignerFromAccount(deployer);
  console.log("Flux Oracle App Created, address", algosdk.encodeAddress(appClient.appAddress.publicKey));
  return appClient;
};
