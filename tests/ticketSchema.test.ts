/**
 * Tests for src/ticketSchema.ts — typed JSON Schema contract.
 */

import { describe, it, expect } from "vitest";
import {
  TICKET_FRONTMATTER_JSON_SCHEMA,
  describeTicketSchema,
} from "../src/ticketSchema.js";

describe("TICKET_FRONTMATTER_JSON_SCHEMA structure", () => {
  it("has type: object", () => {
    expect(TICKET_FRONTMATTER_JSON_SCHEMA.type).toBe("object");
  });

  it("has a properties map with a repo field", () => {
    const props = TICKET_FRONTMATTER_JSON_SCHEMA.properties as Record<string, unknown>;
    expect(props).toBeDefined();
    expect(props.repo).toBeDefined();
  });

  it("properties.priority.enum includes 'high'", () => {
    const props = TICKET_FRONTMATTER_JSON_SCHEMA.properties as Record<string, Record<string, unknown>>;
    const priorityEnum = props.priority.enum as string[];
    expect(priorityEnum).toContain("high");
  });

  it("properties.priority.enum includes all three values", () => {
    const props = TICKET_FRONTMATTER_JSON_SCHEMA.properties as Record<string, Record<string, unknown>>;
    const priorityEnum = props.priority.enum as string[];
    expect(priorityEnum).toContain("low");
    expect(priorityEnum).toContain("normal");
    expect(priorityEnum).toContain("high");
  });

  it("required is an empty array (all fields optional)", () => {
    expect(TICKET_FRONTMATTER_JSON_SCHEMA.required).toEqual([]);
  });

  it("has a $schema field pointing to draft 2020-12", () => {
    expect(TICKET_FRONTMATTER_JSON_SCHEMA.$schema).toMatch(/2020-12/);
  });
});

describe("describeTicketSchema()", () => {
  it("returns valid JSON that round-trips via JSON.parse", () => {
    const s = describeTicketSchema();
    expect(() => JSON.parse(s)).not.toThrow();
    const parsed = JSON.parse(s);
    expect(typeof parsed).toBe("object");
  });

  it("the JSON contains the title 'Junco ticket frontmatter'", () => {
    expect(describeTicketSchema()).toContain("Junco ticket frontmatter");
  });

  it("is stack-agnostic: contains no mentions of internal engine names", () => {
    const s = describeTicketSchema();
    expect(s).not.toMatch(/omp|omlx|\bpi\b|launchd|qwen/i);
  });

  it("documents all expected frontmatter fields", () => {
    const s = describeTicketSchema();
    const expected = [
      "id", "repo", "priority", "timeout_minutes", "base_branch",
      "branch_name", "pr_title", "draft", "labels", "reviewers", "amends_pr",
    ];
    for (const field of expected) {
      expect(s).toContain(`"${field}"`);
    }
  });
});
