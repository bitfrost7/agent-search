import { defineChannelSpec } from "../plugin.js";
import { validateRequestAgainstSupports } from "./channel-spec.js";

/** Shared shape for web engines whose execution params are only query and limit. */
export function defineWebEngineSpec(
  name: string,
  description: string,
  opts: { language?: boolean } = {},
) {
  return defineChannelSpec<{ query: string; limit: number; language?: string }>({
    name,
    category: "web search",
    description,
    intents: ["web", "docs"],
    contentTypes: ["web_page", "article"],
    supports: {
      limit: true,
      page: false,
      sort: false,
      timeRange: false,
      language: opts.language ?? false,
    },
    defaults: { limit: 5 },
    mapRequest(req) {
      const { warnings, errors } = validateRequestAgainstSupports(
        req,
        this.supports,
        this.name,
      );
      return {
        ok: errors.length === 0,
        params: {
          query: req.query,
          limit: req.limit,
          language: req.language,
        },
        warnings,
        errors,
      };
    },
  });
}
