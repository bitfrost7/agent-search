import { Registry } from "../../src/registry.js";

export const testRegistry = new Registry();
await testRegistry.init();

export const resolveTestSpec = (name: string) => testRegistry.getSpec(name);

export const registeredTestSpecs = () =>
  testRegistry
    .list()
    .map((channel) => testRegistry.getSpec(channel.name))
    .filter((spec) => spec !== undefined);
