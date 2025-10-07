import { ACCELERATIONS, WAYPOINT_SEQUENCE, MAX_VELOCITY_MANHATTAN_DISTANCE, BFS_MAX_STEPS } from './config.js';
import { getProjectedMove, checkWinCondition, checkCollision, segmentsIntersect, checkVectorCrossedTileType } from './game-mechanics.js';
import { PriorityQueue } from './utils.js';

// Return the best AI move (simple heuristic: prefer winning > safe > furthest along nextWaypoint)
export function getBestAIMove(gameState, track) {
    if (!gameState) return null;
    const aiState = gameState.players.find(p => p.id === 2);
    if (!aiState) return null;

    const mock = { pos: aiState.pos, v: aiState.v, prevPos: aiState.prevPos, nextWaypointIndex: aiState.nextWaypointIndex };
    const moves = ACCELERATIONS.map(a => getProjectedMove(mock, a.ax, a.ay, 2, gameState, track));

    // Prefer winning moves
    let chosen = moves.find(m => m.isWin);
    if (chosen) return chosen;

    // Prefer safe moves and pick the one with largest increase in nextWaypointIndex, then by Manhattan speed progress
    const safeMoves = moves.filter(m => m.isSafe);
    if (safeMoves.length > 0) {
        safeMoves.sort((a, b) => {
            if (a.nextWaypointIndex !== b.nextWaypointIndex) return b.nextWaypointIndex - a.nextWaypointIndex;
            const aDist = Math.abs(a.v.dx) + Math.abs(a.v.dy);
            const bDist = Math.abs(b.v.dx) + Math.abs(b.v.dy);
            return bDist - aDist;
        });
        return safeMoves[0];
    }

    // Fallback: return any move (first)
    return moves[0] || null;
}

// Dijkstra-like search (cost = turns) that accounts for skip-turn penalties on crashes.
// Returns { path, status, explored } where path is array of { pos, move } from start -> goal
export function findOptimalPath(startState, maxSteps = 5000, actorId = null, gameState, track) {
    // Heuristic `h`: estimates turns to goal. Admissible since max speed is a constant.
    function heuristic(node) {
        let targetTiles = [];
        if (node.nextWaypointIndex < WAYPOINT_SEQUENCE.length) {
            targetTiles = track.waypoints[WAYPOINT_SEQUENCE[node.nextWaypointIndex]] || [];
        } else {
            targetTiles = track.waypoints['S'] || [];
        }
        if (targetTiles.length === 0) return 0; // No goal, no heuristic

        // Find the closest target tile to the node's position
        let minDistance = Infinity;
        for (const target of targetTiles) {
            const dist = Math.abs(node.pos.x - target.x) + Math.abs(node.pos.y - target.y);
            if (dist < minDistance) minDistance = dist;
        }
        
        return minDistance / MAX_VELOCITY_MANHATTAN_DISTANCE;
    }

    function stateKey(s) {
        return `${s.pos.x.toFixed(3)}|${s.pos.y.toFixed(3)}|${s.v.dx}|${s.v.dy}|${s.nextWaypointIndex}`;
    }

    const startNode = { pos: { x: startState.pos.x, y: startState.pos.y }, v: { dx: startState.v.dx, dy: startState.v.dy }, prev: null, move: null, nextWaypointIndex: startState.nextWaypointIndex };

    const frontier = new PriorityQueue();
    frontier.enqueue({ node: startNode, cost: 0 }, 0 + heuristic(startNode));

    const bestCost = new Map();
    bestCost.set(stateKey(startNode), 0);

    let exploredCount = 0;
    let iterations = 0;

    while (!frontier.isEmpty() && iterations < maxSteps) {
        const current = frontier.dequeue();
        const node = current.node;
        const costSoFar = current.cost;
        iterations++;

        // Goal test: if passed all waypoints and next vector crosses finish
        if (node.nextWaypointIndex >= WAYPOINT_SEQUENCE.length) {
            const projectedPos = { x: node.pos.x + node.v.dx, y: node.pos.y + node.v.dy };
            if (checkWinCondition(projectedPos, { pos: node.pos, prevPos: node.prevPos || node.pos, v: node.v, nextWaypointIndex: node.nextWaypointIndex }, track)) {
                // reconstruct path
                const path = [];
                let cur = node;
                while (cur && cur.move !== null) {
                    path.unshift({ pos: cur.pos, move: cur.move });
                    cur = cur.prev;
                }
                return { path: path, status: 'found', explored: exploredCount };
            }
        }

        // Expand neighbors
        for (let accel of ACCELERATIONS) {
            const projectedV = { dx: node.v.dx + accel.ax, dy: node.v.dy + accel.ay };
            const manhattanD = Math.abs(projectedV.dx) + Math.abs(projectedV.dy);
            if (manhattanD > MAX_VELOCITY_MANHATTAN_DISTANCE) continue; // invalid by speed

            const projectedPos = { x: node.pos.x + projectedV.dx, y: node.pos.y + projectedV.dy };
            const crash = checkCollision(node.pos, projectedPos, track);
            const isSafe = crash === null;

            // Player collision checks (if actorId provided)
            let finalIsSafe = isSafe;
            let crashReason = null;
            if (actorId !== null && gameState) {
                // Only check for player collisions if it's the actor's turn. This must match getProjectedMove's logic.
                if (gameState.currentTurn === actorId) {
                    const opponent = gameState.players.find(p => p.id !== actorId);
                if (opponent) {
                    if (Math.abs(projectedPos.x - opponent.pos.x) < 0.001 && Math.abs(projectedPos.y - opponent.pos.y) < 0.001) {
                        finalIsSafe = false;
                        crashReason = 'player_collision';
                    }
                    if (opponent.prevPos && segmentsIntersect(node.pos, projectedPos, opponent.prevPos, opponent.pos)) {
                        finalIsSafe = false;
                        crashReason = 'cross_opponent';
                    }
                }
                }
            }

            const nextWaypointIndex = (function() {
                let idx = node.nextWaypointIndex;
                if (idx < WAYPOINT_SEQUENCE.length) {
                    const nextTileType = WAYPOINT_SEQUENCE[idx];
                    if (checkVectorCrossedTileType(node.pos, projectedPos, nextTileType, track)) idx++;
                }
                return idx;
            })();

            // compute cost for this action
            // base cost is 1 turn; if crash occurs, add penalty equal to Manhattan speed of attempted move (min 1)
            let actionCost = 1;
            if (!finalIsSafe) {
                const attemptedSpeed = Math.abs(projectedV.dx) + Math.abs(projectedV.dy);
                actionCost += Math.max(1, Math.floor(attemptedSpeed));
            }

            const child = {
                pos: finalIsSafe ? projectedPos : node.pos,
                prev: node,
                move: { ax: accel.ax, ay: accel.ay },
                v: finalIsSafe ? projectedV : { dx: 0, dy: 0 },
                nextWaypointIndex: finalIsSafe ? nextWaypointIndex : node.nextWaypointIndex,
                crashReason: crashReason
            };

            const key = stateKey(child);
            const newCost = costSoFar + actionCost;
            const prevBest = bestCost.has(key) ? bestCost.get(key) : Infinity;
            if (newCost < prevBest) {
                bestCost.set(key, newCost);
                frontier.enqueue({ node: child, cost: newCost }, newCost + heuristic(child));
                exploredCount++;
            }
        }
    }

    if (iterations >= maxSteps) return { path: null, status: 'limited', explored: exploredCount };
    return { path: null, status: 'not_found', explored: exploredCount };
}

export function drawAIPath(ctx, aiPlannedPath, gameState, CELL_SIZE) {
    if (!aiPlannedPath || aiPlannedPath.length === 0) return;
    try {
        ctx.strokeStyle = 'rgba(16,185,129,0.28)'; // soft green for planned path
        ctx.lineWidth = 2;
        const aiState = gameState.players.find(p => p.id === 2);
        ctx.beginPath();
        ctx.moveTo(aiState.pos.x * CELL_SIZE, aiState.pos.y * CELL_SIZE);
        for (let step of aiPlannedPath) {
            ctx.lineTo(step.pos.x * CELL_SIZE, step.pos.y * CELL_SIZE);
        }
        ctx.stroke();

        ctx.fillStyle = 'rgba(16,185,129,0.28)';
        for (let step of aiPlannedPath) {
            ctx.beginPath();
            ctx.arc(step.pos.x * CELL_SIZE, step.pos.y * CELL_SIZE, CELL_SIZE / 6, 0, Math.PI * 2);
            ctx.fill();
        }
    } catch (e) {}
}

export function aiMakeMove(gameState, track, applyMove, aiPlannedPath) {
    if (!gameState || gameState.currentTurn !== 2) return;

    // If we have a planned BFS path, validate and use its first move
    if (aiPlannedPath && aiPlannedPath.length > 0) {
        const first = aiPlannedPath[0];
        if (first && typeof first.move !== 'undefined') {
            const aiCurrentState = gameState.players.find(p => p.id === 2);
            const mock = { pos: aiCurrentState.pos, v: aiCurrentState.v, nextWaypointIndex: aiCurrentState.nextWaypointIndex };
            const projected = getProjectedMove(mock, first.move.ax, first.move.ay, 2, gameState, track);
            
            // If the planned move is now unsafe (e.g., opponent moved into the path), invalidate the plan.
            // The code will then proceed to recalculate a new path.
            if (projected && !projected.isSafe) {
                aiPlannedPath = null; // Invalidate the entire path
            } else if (projected) {
                // The planned move is safe, so execute it.
                applyMove(projected, 2);
                aiPlannedPath.shift();
                return;
            }
        }
    }

    // If there's no valid plan, calculate a new one now and execute the first step.
    const aiState = gameState.players.find(p => p.id === 2);
    const startState = { pos: aiState.pos, v: aiState.v, nextWaypointIndex: aiState.nextWaypointIndex };
    console.time('AI Path Recalculation (in aiMakeMove)');
    const searchResult = findOptimalPath(startState, BFS_MAX_STEPS, 2, gameState, track);
    console.timeEnd('AI Path Recalculation (in aiMakeMove)');

    aiPlannedPath = (searchResult && searchResult.path) ? searchResult.path : null;

    // Now that a new path is calculated, try to execute the first step again.
    if (aiPlannedPath && aiPlannedPath.length > 0) {
        const first = aiPlannedPath[0];
        if (first && typeof first.move !== 'undefined') {
            const mock = { pos: aiState.pos, v: aiState.v, nextWaypointIndex: aiState.nextWaypointIndex };
            const projected = getProjectedMove(mock, first.move.ax, first.move.ay, 2, gameState, track);
            if (projected) {
                applyMove(projected, 2);
                aiPlannedPath.shift();
                return;
            }
        }
    }

    // Ultimate fallback: if even the freshly calculated path is invalid (should be rare), use the simple heuristic.
    const best = getBestAIMove(gameState, track);
    if (best) applyMove(best, 2);
}
