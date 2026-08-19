#!/usr/bin/env node
import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
rmSync(resolve(projectRoot, "dist"), { recursive: true, force: true });
