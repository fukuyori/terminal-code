import fs from "node:fs";
import path from "node:path";

import { DATA_DIR } from "../runtime/paths";

/** Where a chord should live: freed in the terminal, carried by another chord
 * on the editor side, or left exactly as it is. An editor decision remembers
 * which chord carries it. */
export interface Decision {
  choice: "terminal" | "editor" | "keep";
  key?: string;
  /** For a terminal or claimant move: what the chord ran, so the rebind can
   * carry it. */
  action?: string;
  /** For a claimant move: the binding's original when clause, carried along. */
  guard?: string;
  /** For a claimant move: who holds the chord. Absent means an editor-side
   * holder resolved through keybindings.json; "terminal" means the terminal
   * itself, resolved through the provider's freed file instead. */
  owner?: "terminal";
  /** For an editor move: the editor command the new chord should run, staged
   * from the conflict when the decision was made. */
  command?: string;
}

export interface Decisions {
  version: 1;
  terminal: string;
  choices: Record<string, Decision>;
}

export const DECISIONS_FILE = path.join(DATA_DIR, "shortcuts.json");

/** The decision file's mtime, for cache keys that must react to an apply. */
export function decisionsStamp(): number {
  try {
    return fs.statSync(DECISIONS_FILE).mtimeMs;
  } catch {
    return 0;
  }
}

export function loadDecisions(): Decisions | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(DECISIONS_FILE, "utf8")) as Decisions;
    return parsed && parsed.version === 1 && parsed.choices ? parsed : null;
  } catch {
    return null;
  }
}

export function saveDecisions(decisions: Decisions): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(DECISIONS_FILE, `${JSON.stringify(decisions, null, 2)}\n`);
}

export function clearDecisions(): void {
  fs.rmSync(DECISIONS_FILE, { force: true });
}

/** Where a chord chosen with TODE_QUIT_CHORD is kept, so it survives the shell
 * that set it. */
export const QUIT_CHORD_FILE = path.join(DATA_DIR, "quit-chord");

function chosenChord(): string | null {
  const wanted = process.env.TODE_QUIT_CHORD?.trim().toLowerCase();
  return wanted ? wanted : null;
}

function rememberedChord(): string | null {
  try {
    return fs.readFileSync(QUIT_CHORD_FILE, "utf8").trim().toLowerCase() || null;
  } catch {
    return null;
  }
}

/** What quits the editor. ctrl+q everywhere but macOS, where it is ctrl+c —
 * unless the terminal already owns that chord and will never pass it on. The
 * wizard negotiates this where it has a backend; where it does not (Windows),
 * TODE_QUIT_CHORD names the chord outright and the next open remembers it. */
export const QUIT_CHORD =
  chosenChord() ?? rememberedChord() ?? (process.platform === "darwin" ? "ctrl+c" : "ctrl+q");

/** Persist a chord asked for through the environment. Called from the install
 * step rather than at load, so importing this module writes nothing. */
export function rememberQuitChord(): void {
  const wanted = chosenChord();
  if (!wanted || wanted === rememberedChord()) return;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(QUIT_CHORD_FILE, `${wanted}\n`);
  } catch {}
}

export const QUIT_COMMAND = "tode.confirmQuit";

export const IMPORT_DECISION_ID = `import:${QUIT_CHORD}`;

export const CLAIM_DECISION_ID = `claim:${QUIT_CHORD}`;

export function claimBindings(): { key: string; command: string; when?: string }[] {
  const choices = loadDecisions()?.choices ?? {};
  const out: { key: string; command: string; when?: string }[] = [];
  for (const [id, decision] of Object.entries(choices)) {
    if (!id.startsWith("claim:")) continue;
    if (decision.owner === "terminal") continue;
    if (decision.choice !== "terminal" || !decision.action) continue;
    const rest = id.slice("claim:".length);
    const named = rest.indexOf(":");
    const chord = named === -1 ? rest : rest.slice(0, named);
    out.push({ key: chord, command: `-${decision.action}` });
    if (decision.key) out.push({ key: decision.key, command: decision.action, when: decision.guard });
  }
  return out;
}

export function overrideBindings(): { key: string; command: string; when?: string }[] {
  const choices = loadDecisions()?.choices ?? {};
  const out: { key: string; command: string; when?: string }[] = [];
  for (const [id, decision] of Object.entries(choices)) {
    if (!id.startsWith("import:")) continue;
    if (decision.choice !== "editor" || !decision.key) continue;
    const command = decision.command ?? (id === IMPORT_DECISION_ID ? QUIT_COMMAND : null);
    if (!command) continue;
    out.push({ key: decision.key, command, when: "!terminalFocus" });
  }
  return out;
}

/** Where tode's ctrl+c bindings may fire at all: never in the terminal, never
 * over a selection or an input box. inputFocus is true inside the editor too,
 * so it must not veto editor focus — only genuine input boxes (inputFocus
 * without editorTextFocus). */
const HINT_BASE = "!terminalFocus && !editorHasSelection && (!inputFocus || editorTextFocus)";

export function quitWhen(): string {
  return QUIT_CHORD === "ctrl+c" ? HINT_BASE : "!terminalFocus";
}

/** The guard on the ctrl+c redirect hint, where ctrl+c is not itself quit —
 * uncarved for the same reason quit is. */
export function hintWhen(): string {
  return HINT_BASE;
}

// what is a hint binding? i dont think thats a thing??
export function hintBindings(): { key: string; command: string; when: string }[] {
  if (QUIT_CHORD === "ctrl+c") return [];
  return [{ key: "ctrl+c", command: "tode.quitHint", when: hintWhen() }];
}

export function quitBindings(): { key: string; command: string; when?: string }[] {
  const choices = loadDecisions()?.choices ?? {};
  const decision = choices[IMPORT_DECISION_ID] ?? choices[QUIT_CHORD];
  if (decision?.choice === "editor" || decision?.choice === "keep") return [];
  return [{ key: QUIT_CHORD, command: QUIT_COMMAND, when: quitWhen() }];
}

export function fallbackBindings(): { key: string; command: string; when?: string }[] {
  const decisions = loadDecisions();
  if (!decisions) return [];
  return Object.entries(decisions.choices).flatMap(([id, decision]) => {
    if (id.startsWith("claim:") || id.startsWith("import:")) return [];
    if (decision.choice !== "editor" || !decision.key || !decision.command) return [];
    return [{ key: decision.key, command: decision.command, when: "!terminalFocus" }];
  });
}
