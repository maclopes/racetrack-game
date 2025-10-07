import { WAYPOINT_SEQUENCE, MAX_VELOCITY_MANHATTAN_DISTANCE } from './config.js';

export function getInitialVelocity() {
    // This is the v0.1 initial velocity
    return { dx: 1, dy: -1 };
}

export function getTileType(x, y, track) {
    const GRID_WIDTH = track.map[0].length;
    const GRID_HEIGHT = track.map.length;
    if (!isFinite(x) || !isFinite(y)) return 'X';
    const floorX = Math.floor(x);
    const floorY = Math.floor(y);
    
    if (floorX < 0 || floorX >= GRID_WIDTH || floorY < 0 || floorY >= GRID_HEIGHT) {
        return 'X'; 
    }
    return track.map[floorY][floorX];
}

export function isPointOnTrack(x, y, track) {
    const type = getTileType(x, y, track);
    return type !== 'X';
}

export function checkVectorCrossedTileType(p1, p2, targetTileType, track) {
    const dx = p2.x - p1.x;
    const dy = p2.y - p1.y;
    const steps = Math.max(Math.abs(dx), Math.abs(dy), 1); 
    
    for (let i = 0; i <= steps; i++) {
        const t = i / steps; 
        const gridX = p1.x + t * dx;
        const gridY = p1.y + t * dy;
        
        if (getTileType(gridX, gridY, track) === targetTileType) {
            return true;
        }
    }
    return false;
}

export function checkCollision(p1, p2, track) {
    const dx = p2.x - p1.x;
    const dy = p2.y - p1.y;
    const steps = Math.max(Math.abs(dx), Math.abs(dy), 1); 

    if (!isPointOnTrack(p1.x, p1.y, track)) return { x: Math.floor(p1.x), y: Math.floor(p1.y) }; 

    for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        const currentX = p1.x + t * dx;
        const currentY = p1.y + t * dy;
        
        if (!isPointOnTrack(currentX, currentY, track)) {
            return { x: Math.floor(currentX), y: Math.floor(currentY) };
        }
    }
    return null;
}

// Return true if segment p1->p2 intersects segment q1->q2 (excluding touching at endpoints as crossing)
export function segmentsIntersect(p1, p2, q1, q2) {
    function orient(a, b, c) {
        return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
    }
    const o1 = orient(p1, p2, q1);
    const o2 = orient(p1, p2, q2);
    const o3 = orient(q1, q2, p1);
    const o4 = orient(q1, q2, p2);

    return (o1 * o2 < 0) && (o3 * o4 < 0);
}

export function checkWinCondition(p2, playerState, track) {
    if (playerState.nextWaypointIndex < WAYPOINT_SEQUENCE.length) {
        return false; 
    }
    // Finish if the vector crosses any of the start/finish markers: 'S', 'A', or 'B'
    return checkVectorCrossedTileType(playerState.prevPos, p2, 'S', track)
        || checkVectorCrossedTileType(playerState.prevPos, p2, 'A', track)
        || checkVectorCrossedTileType(playerState.prevPos, p2, 'B', track);
}

export function getProjectedMove(mockPlayerState, ax, ay, actorId, gameState, track) {
    const projectedV = {
        dx: mockPlayerState.v.dx + ax,
        dy: mockPlayerState.v.dy + ay
    };
    
    const manhattanD = Math.abs(projectedV.dx) + Math.abs(projectedV.dy);
    const isSpeedSafe = manhattanD <= MAX_VELOCITY_MANHATTAN_DISTANCE;

    if (!isSpeedSafe) {
        return { 
            pos: mockPlayerState.pos, 
            crashPos: { 
                x: Math.floor(mockPlayerState.pos.x), 
                y: Math.floor(mockPlayerState.pos.y),
                reason: 'speed_violation' 
            }, 
            isSafe: false, 
            isWin: false,
            ax: ax,
            ay: ay,
            v: projectedV, 
            nextWaypointIndex: mockPlayerState.nextWaypointIndex
        };
    }

    const projectedPos = {
        x: mockPlayerState.pos.x + projectedV.dx,
        y: mockPlayerState.pos.y + projectedV.dy
    };
    
    let crashPos = checkCollision(mockPlayerState.pos, projectedPos, track);
    let isTrackSafe = crashPos === null;

    // Player collisions: cannot end on top of the other player or cross their last movement vector
    try {
        if (gameState && actorId !== null) {
            const opponent = gameState.players.find(p => p.id !== actorId);
            if (opponent) {
                // Ending on opponent
                if (Math.abs(projectedPos.x - opponent.pos.x) < 0.001 && Math.abs(projectedPos.y - opponent.pos.y) < 0.001) {
                    crashPos = { x: Math.floor(opponent.pos.x), y: Math.floor(opponent.pos.y), reason: 'player_collision' };
                    isTrackSafe = false;
                }
                // Crossing opponent last vector
                if (opponent.prevPos && (segmentsIntersect(mockPlayerState.pos, projectedPos, opponent.prevPos, opponent.pos))) {
                    crashPos = { x: Math.floor(mockPlayerState.pos.x), y: Math.floor(mockPlayerState.pos.y), reason: 'cross_opponent' };
                    isTrackSafe = false;
                }
            }
        }
    } catch (e) {}

    let nextWaypointIndex = mockPlayerState.nextWaypointIndex;
    let isWin = false;

    if (isTrackSafe) {
        const nextCheckpointIndex = mockPlayerState.nextWaypointIndex;
        if (nextCheckpointIndex < WAYPOINT_SEQUENCE.length) {
            const nextTileType = WAYPOINT_SEQUENCE[nextCheckpointIndex];
            if (checkVectorCrossedTileType(mockPlayerState.pos, projectedPos, nextTileType, track)) {
                nextWaypointIndex++;
            }
        }
        
        const stateAfterWaypointCheck = { ...mockPlayerState, prevPos: mockPlayerState.pos, nextWaypointIndex: nextWaypointIndex };
        isWin = checkWinCondition(projectedPos, stateAfterWaypointCheck, track);
    }
    
    const projectedMove = {
        pos: projectedPos,
        crashPos: crashPos,
        isSafe: isTrackSafe,
        isWin: isWin,
        ax: ax,
        ay: ay,
        v: projectedV,
        nextWaypointIndex: nextWaypointIndex
    };

    // projection logging removed to keep console minimal

    return projectedMove;
}

export async function applyMove(move, actorId, gameState, gameHash, db, localGameMode, myPlayerId, aiMakeMove, aiThinkingTimeout) {
    if (!gameState) return null;
    const actingPlayer = actorId !== null ? actorId : myPlayerId;
    if (gameState.currentTurn !== actingPlayer) return null;

    const playerIndex = gameState.players.findIndex(p => p.id === actingPlayer);
    if (playerIndex === -1) return null;

    const newStatus = move.isWin ? (actingPlayer === 1 ? 'P1_won' : 'P2_won') : 'playing';

    const newPlayerState = { ...gameState.players[playerIndex] };

    if (move.isSafe) {
        newPlayerState.prevPos = newPlayerState.pos;
        newPlayerState.pos = move.pos;
        newPlayerState.v = move.v;
        newPlayerState.nextWaypointIndex = move.nextWaypointIndex;
        newPlayerState.safe = true;
        newPlayerState.skipTurns = newPlayerState.skipTurns || 0;
    } else {
        newPlayerState.prevPos = newPlayerState.pos;
        newPlayerState.v = { dx: 0, dy: 0 };
        newPlayerState.safe = false;
        try {
            if (actingPlayer === 2) aiPlannedPath = null;
            if (actingPlayer === myPlayerId) playerPlannedPath = null;

            const manhattan = Math.abs(move.v.dx || 0) + Math.abs(move.v.dy || 0);
            newPlayerState.skipTurns = Math.max(1, Math.floor(manhattan));
        } catch (e) {
            newPlayerState.skipTurns = (newPlayerState.skipTurns || 0) + 1;
        }
    }

    const updates = {
        status: newStatus,
        players: [...gameState.players]
    };
    updates.players[playerIndex] = newPlayerState;

    function computeNextTurn(players, fromId) {
        let idx = players.findIndex(p => p.id === fromId);
        if (idx === -1) return fromId;
        for (let i = 1; i <= players.length; i++) {
            const candidate = players[(idx + i) % players.length];
            if (candidate.skipTurns && candidate.skipTurns > 0) {
                candidate.skipTurns = Math.max(0, candidate.skipTurns - 1);
                continue;
            }
            return candidate.id;
        }
        return fromId;
    }

    if (newStatus === 'playing') {
        updates.currentTurn = computeNextTurn(updates.players, actingPlayer);
    } else {
        updates.currentTurn = actingPlayer;
    }

    if (localGameMode === 'local' || localGameMode === 'ai') {
        const newGameState = { ...gameState, ...updates };
        if (!newGameState.player2Id) newGameState.player2Id = localGameMode === 'ai' ? 'AI' : 'LOCAL';
        
        if (localGameMode === 'ai' && newGameState.currentTurn === 2 && newGameState.status === 'playing') {
            if (aiThinkingTimeout) clearTimeout(aiThinkingTimeout);
            aiThinkingTimeout = setTimeout(() => aiMakeMove(), 400 + Math.random() * 400);
        }
        return { newGameState, aiThinkingTimeout };
    }

    try {
        const gameRef = firebase.doc(db, `artifacts/default-app-id/public/data/racetrack_games/${gameHash}`);
        await firebase.setDoc(gameRef, updates, { merge: true });
    } catch (error) {
        console.error("Error applying move:", error);
        document.getElementById('statusMessage').textContent = 'Error saving move. Check console.';
    }
    return null;
}