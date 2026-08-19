import type { BaseChannel } from "./channel.js";
import type { ChannelSpec } from "./search/channel-spec.js";

export interface ChannelConstructor {
  new (): BaseChannel;
}

export interface ChannelPlugin {
  spec: ChannelSpec;
  Channel: ChannelConstructor;
}

export function defineChannelSpec<TParams>(
  spec: ChannelSpec<TParams>,
): ChannelSpec<TParams> {
  return spec;
}

export function defineChannelPlugin(
  spec: ChannelSpec,
  Channel: ChannelConstructor,
): ChannelPlugin {
  return { spec, Channel };
}
