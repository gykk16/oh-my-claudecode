#!/usr/bin/env node

/**
 * OMC Persistent Mode Hook (Node.js)
 * Minimal continuation enforcer for all OMC modes.
 * Stripped down for reliability — no optional imports, no PRD, no notepad pruning.
 *
 * Supported modes: ralph, autopilot, ultrapilot, swarm, ultrawork, ecomode, ultraqa, pipeline
 */

import { existsSync, readFileSync, writeFileSync, readdirSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf-8');
}

function readJsonFile(path) {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return null;
  }
}

function writeJsonFile(path, data) {
  try {
    // Ensure directory exists
    const dir = path.substring(0, path.lastIndexOf('/'));
    if (dir && !existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(path, JSON.stringify(data, null, 2));
    return true;
  } catch {
    return false;
  }
}

/**
 * Read state file from local or global location, tracking the source.
 */
function readStateFile(stateDir, globalStateDir, filename) {
  const localPath = join(stateDir, filename);
  const globalPath = join(globalStateDir, filename);

  let state = readJsonFile(localPath);
  if (state) return { state, path: localPath };

  state = readJsonFile(globalPath);
  if (state) return { state, path: globalPath };

  return { state: null, path: localPath }; // Default to local for new writes
}

/**
 * Count incomplete Tasks from Claude Code's native Task system.
 */
function countIncompleteTasks(sessionId) {
  if (!sessionId || typeof sessionId !== 'string') return 0;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,255}$/.test(sessionId)) return 0;

  const taskDir = join(homedir(), '.claude', 'tasks', sessionId);
  if (!existsSync(taskDir)) return 0;

  let count = 0;
  try {
    const files = readdirSync(taskDir).filter(f => f.endsWith('.json') && f !== '.lock');
    for (const file of files) {
      try {
        const content = readFileSync(join(taskDir, file), 'utf-8');
        const task = JSON.parse(content);
        if (task.status === 'pending' || task.status === 'in_progress') count++;
      } catch { /* skip */ }
    }
  } catch { /* skip */ }
  return count;
}

function countIncompleteTodos(todosDir, projectDir) {
  let count = 0;

  if (existsSync(todosDir)) {
    try {
      const files = readdirSync(todosDir).filter(f => f.endsWith('.json'));
      for (const file of files) {
        try {
          const content = readFileSync(join(todosDir, file), 'utf-8');
          const data = JSON.parse(content);
          const todos = Array.isArray(data) ? data : (Array.isArray(data?.todos) ? data.todos : []);
          count += todos.filter(t => t.status !== 'completed' && t.status !== 'cancelled').length;
        } catch { /* skip */ }
      }
    } catch { /* skip */ }
  }

  for (const path of [
    join(projectDir, '.omc', 'todos.json'),
    join(projectDir, '.claude', 'todos.json')
  ]) {
    try {
      const data = readJsonFile(path);
      const todos = Array.isArray(data) ? data : (Array.isArray(data?.todos) ? data.todos : []);
      count += todos.filter(t => t.status !== 'completed' && t.status !== 'cancelled').length;
    } catch { /* skip */ }
  }

  return count;
}

async function main() {
  try {
    const input = await readStdin();
    let data = {};
    try { data = JSON.parse(input); } catch {}

    const directory = data.directory || process.cwd();
    const sessionId = data.sessionId || data.session_id || '';
    const todosDir = join(homedir(), '.claude', 'todos');
    const stateDir = join(directory, '.omc', 'state');
    const globalStateDir = join(homedir(), '.omc', 'state');

    // Read all mode states (local-first with fallback to global)
    const ralph = readStateFile(stateDir, globalStateDir, 'ralph-state.json');
    const autopilot = readStateFile(stateDir, globalStateDir, 'autopilot-state.json');
    const ultrapilot = readStateFile(stateDir, globalStateDir, 'ultrapilot-state.json');
    const ultrawork = readStateFile(stateDir, globalStateDir, 'ultrawork-state.json');
    const ecomode = readStateFile(stateDir, globalStateDir, 'ecomode-state.json');
    const ultraqa = readStateFile(stateDir, globalStateDir, 'ultraqa-state.json');
    const pipeline = readStateFile(stateDir, globalStateDir, 'pipeline-state.json');

    // Swarm uses swarm-summary.json (not swarm-state.json) + marker file
    const swarmMarker = existsSync(join(stateDir, 'swarm-active.marker'));
    const swarmSummary = readJsonFile(join(stateDir, 'swarm-summary.json'));

    // Count incomplete items
    const taskCount = countIncompleteTasks(sessionId);
    const todoCount = countIncompleteTodos(todosDir, directory);
    const totalIncomplete = taskCount + todoCount;

    // Priority 1: Ralph Loop (explicit persistence mode)
    if (ralph.state?.active) {
      const iteration = ralph.state.iteration || 1;
      const maxIter = ralph.state.max_iterations || 100;

      if (iteration < maxIter) {
        ralph.state.iteration = iteration + 1;
        writeJsonFile(ralph.path, ralph.state);

        console.log(JSON.stringify({
          continue: false,
          reason: `[RALPH LOOP - ITERATION ${iteration + 1}/${maxIter}] Work is NOT done. Continue. When complete, output: <promise>${ralph.state.completion_promise || 'DONE'}</promise>\n${ralph.state.prompt ? `Task: ${ralph.state.prompt}` : ''}`
        }));
        return;
      }
    }

    // Priority 2: Autopilot (high-level orchestration)
    if (autopilot.state?.active) {
      const phase = autopilot.state.phase || 'unknown';
      if (phase !== 'complete') {
        const newCount = (autopilot.state.reinforcement_count || 0) + 1;
        if (newCount <= 20) {
          autopilot.state.reinforcement_count = newCount;
          writeJsonFile(autopilot.path, autopilot.state);

          console.log(JSON.stringify({
            continue: false,
            reason: `[AUTOPILOT - Phase: ${phase}] Autopilot not complete. Continue working.`
          }));
          return;
        }
      }
    }

    // Priority 3: Ultrapilot (parallel autopilot)
    if (ultrapilot.state?.active) {
      const workers = ultrapilot.state.workers || [];
      const incomplete = workers.filter(w => w.status !== 'complete' && w.status !== 'failed').length;
      if (incomplete > 0) {
        const newCount = (ultrapilot.state.reinforcement_count || 0) + 1;
        if (newCount <= 20) {
          ultrapilot.state.reinforcement_count = newCount;
          writeJsonFile(ultrapilot.path, ultrapilot.state);

          console.log(JSON.stringify({
            continue: false,
            reason: `[ULTRAPILOT] ${incomplete} workers still running. Continue.`
          }));
          return;
        }
      }
    }

    // Priority 4: Swarm (coordinated agents with SQLite)
    if (swarmMarker && swarmSummary?.active) {
      const pending = (swarmSummary.tasks_pending || 0) + (swarmSummary.tasks_claimed || 0);
      if (pending > 0) {
        const newCount = (swarmSummary.reinforcement_count || 0) + 1;
        if (newCount <= 15) {
          swarmSummary.reinforcement_count = newCount;
          writeJsonFile(join(stateDir, 'swarm-summary.json'), swarmSummary);

          console.log(JSON.stringify({
            continue: false,
            reason: `[SWARM ACTIVE] ${pending} tasks remain. Continue working.`
          }));
          return;
        }
      }
    }

    // Priority 5: Pipeline (sequential stages)
    if (pipeline.state?.active) {
      const currentStage = pipeline.state.current_stage || 0;
      const totalStages = pipeline.state.stages?.length || 0;
      if (currentStage < totalStages) {
        const newCount = (pipeline.state.reinforcement_count || 0) + 1;
        if (newCount <= 15) {
          pipeline.state.reinforcement_count = newCount;
          writeJsonFile(pipeline.path, pipeline.state);

          console.log(JSON.stringify({
            continue: false,
            reason: `[PIPELINE - Stage ${currentStage + 1}/${totalStages}] Pipeline not complete. Continue.`
          }));
          return;
        }
      }
    }

    // Priority 6: UltraQA (QA cycling)
    if (ultraqa.state?.active) {
      const cycle = ultraqa.state.cycle || 1;
      const maxCycles = ultraqa.state.max_cycles || 10;
      if (cycle < maxCycles && !ultraqa.state.all_passing) {
        ultraqa.state.cycle = cycle + 1;
        writeJsonFile(ultraqa.path, ultraqa.state);

        console.log(JSON.stringify({
          continue: false,
          reason: `[ULTRAQA - Cycle ${cycle + 1}/${maxCycles}] Tests not all passing. Continue fixing.`
        }));
        return;
      }
    }

    // Priority 7: Ultrawork with incomplete todos/tasks
    if (ultrawork.state?.active && totalIncomplete > 0) {
      const newCount = (ultrawork.state.reinforcement_count || 0) + 1;
      const maxReinforcements = ultrawork.state.max_reinforcements || 15;

      if (newCount > maxReinforcements) {
        console.log(JSON.stringify({
          continue: true,
          reason: `[ULTRAWORK ESCAPE] Max reinforcements reached. Allowing stop.`
        }));
        return;
      }

      ultrawork.state.reinforcement_count = newCount;
      ultrawork.state.last_checked_at = new Date().toISOString();
      writeJsonFile(ultrawork.path, ultrawork.state);

      const itemType = taskCount > 0 ? 'Tasks' : 'todos';
      console.log(JSON.stringify({
        continue: false,
        reason: `[ULTRAWORK #${newCount}] ${totalIncomplete} incomplete ${itemType}. Continue working.\n${ultrawork.state.original_prompt ? `Task: ${ultrawork.state.original_prompt}` : ''}`
      }));
      return;
    }

    // Priority 8: Ecomode with incomplete todos/tasks
    if (ecomode.state?.active && totalIncomplete > 0) {
      const newCount = (ecomode.state.reinforcement_count || 0) + 1;
      const maxReinforcements = ecomode.state.max_reinforcements || 15;

      if (newCount > maxReinforcements) {
        console.log(JSON.stringify({
          continue: true,
          reason: `[ECOMODE ESCAPE] Max reinforcements reached. Allowing stop.`
        }));
        return;
      }

      ecomode.state.reinforcement_count = newCount;
      writeJsonFile(ecomode.path, ecomode.state);

      const itemType = taskCount > 0 ? 'Tasks' : 'todos';
      console.log(JSON.stringify({
        continue: false,
        reason: `[ECOMODE #${newCount}] ${totalIncomplete} incomplete ${itemType}. Continue working.`
      }));
      return;
    }

    // Priority 9: Generic Task/Todo continuation (no specific mode)
    if (totalIncomplete > 0) {
      const contFile = join(stateDir, 'continuation-count.json');
      let contState = readJsonFile(contFile) || { count: 0 };
      contState.count = (contState.count || 0) + 1;
      writeJsonFile(contFile, contState);

      if (contState.count > 15) {
        console.log(JSON.stringify({
          continue: true,
          reason: `[CONTINUATION ESCAPE] Max continuations reached. Allowing stop.`
        }));
        return;
      }

      const itemType = taskCount > 0 ? 'Tasks' : 'todos';
      console.log(JSON.stringify({
        continue: false,
        reason: `[CONTINUATION ${contState.count}/15] ${totalIncomplete} incomplete ${itemType}. Continue working.`
      }));
      return;
    }

    // No blocking needed
    console.log(JSON.stringify({ continue: true }));
  } catch (error) {
    // On any error, allow stop rather than blocking forever
    console.error(`[persistent-mode] Error: ${error.message}`);
    console.log(JSON.stringify({ continue: true }));
  }
}

main();
