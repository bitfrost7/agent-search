import { describe, it, expect } from "vitest";
import TemplateChannel, {
  spec,
} from "../../src/channels/__CATEGORY__/template.js";
import { normalizeSearchRequest } from "../../src/search/schema.js";
import { routeRequest } from "../../src/search/router.js";

describe("TemplateChannel", () => {
  const channel = new TemplateChannel();

  it("keeps implementation and spec identities aligned", () => {
    expect(channel.name).toBe(spec.name);
    expect(channel.category).toBe(spec.category);
  });

  it("maps a unified request through the co-located spec", () => {
    const resolveSpec = (name: string) =>
      name === spec.name ? spec : undefined;
    const { normalized } = normalizeSearchRequest(
      { query: "test", channels: [spec.name] },
      resolveSpec,
    );
    const result = routeRequest(normalized!, resolveSpec);
    expect(result.errors).toEqual([]);
    expect(result.plans[0].mapping.params).toMatchObject({ query: "test" });
  });
});
