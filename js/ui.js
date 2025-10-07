import { WAYPOINT_SEQUENCE } from './config.js';
import { findOptimalPath, getBestAIMove, drawAIPath } from './ai.js';

export function showView(viewId) {
    document.getElementById('lobbyView').classList.add('hidden');
    document.getElementById('gameView').classList.add('hidden');
    document.getElementById('drawTrackView').classList.add('hidden');
    document.getElementById(viewId).classList.remove('hidden');
}

export function updateUI(gameState, myPlayerId) {
    if (!gameState) return;
    document.getElementById('crashMessage').textContent = 'Debug: ' + JSON.stringify(gameState.players);

    document.getElementById('gameIdDisplay').textContent = `ID: ${gameState.gameHash}`;
    const playerColor = myPlayerId === 1 ? 'Blue' : 'Red';
    document.getElementById('currentPlayerInfo').innerHTML = `You are <span class="text-${myPlayerId === 1 ? 'blue' : 'red'}-600 font-extrabold">Player ${myPlayerId} (${playerColor})</span>`;

    const currentTurnPlayer = gameState.players.find(p => p.id === gameState.currentTurn);
    const myTurn = gameState.currentTurn === myPlayerId;
    const statusEl = document.getElementById('statusMessage');
    const crashEl = document.getElementById('crashMessage');
    
    // Explicitly check for P1_won or P2_won
    if (gameState.status === 'P1_won' || gameState.status === 'P2_won') {
        const winnerId = gameState.status === 'P1_won' ? 1 : 2;
        const winnerColor = winnerId === 1 ? 'Blue' : 'Red';
        statusEl.className = "p-4 font-bold text-center rounded-xl bg-green-100 text-green-800 border-4 border-green-500 text-2xl animate-pulse";
        statusEl.textContent = `Game Over! Player ${winnerId} (${winnerColor}) wins!`;
        crashEl.textContent = '';
        document.getElementById('resetText').textContent = myPlayerId === 1 && gameState.player2Id ? 'Delete Game' : 'Forfeit & Start New Game';
        return;
    }

    // Handle Waiting for Opponent (Status is 'lobby')
    if (!gameState.player2Id) {
        statusEl.className = "p-3 font-semibold text-center rounded-lg bg-yellow-100 text-yellow-800 border border-yellow-300";
        statusEl.textContent = "Waiting for an opponent to join...";
        crashEl.textContent = 'Share the Game ID with a friend!';
        document.getElementById('resetText').textContent = 'Delete Game';
        return;
    }
    document.getElementById('resetText').textContent = 'Forfeit & Start New Game';


    // Handle Turn (Status must be 'playing' at this point)
    const playerTurnV = `(V: ${currentTurnPlayer.v.dx}, ${currentTurnPlayer.v.dy})`;

    if (!currentTurnPlayer.safe) {
         crashEl.textContent = 'Velocity reset to (0, 0) due to crash or speed violation.';
    } else {
         crashEl.textContent = '';
    }

    if (myTurn) {
        statusEl.className = `p-3 font-semibold text-center rounded-lg bg-${myPlayerId === 1 ? 'blue' : 'red'}-100 text-${myPlayerId === 1 ? 'blue' : 'red'}-800 border border-${myPlayerId === 1 ? 'blue' : 'red'}-300`;
        statusEl.textContent = `YOUR TURN! ${playerTurnV}`;
    } else {
        statusEl.className = "p-3 font-semibold text-center rounded-lg bg-gray-100 text-gray-700 border border-gray-300";
        statusEl.textContent = `Opponent's Turn... ${playerTurnV}`;
    }

    // Show skip-turn info for players
    try {
        const skipEl = document.getElementById('skipInfo');
        if (skipEl) {
            const parts = [];
            gameState.players.forEach(p => {
                if (p.skipTurns && p.skipTurns > 0) parts.push(`P${p.id} skipped: ${p.skipTurns}`);
            });
            skipEl.textContent = parts.join(' | ');
        }
    } catch (e) {}
}

function drawGrid(ctx, track, CELL_SIZE) {
    const GRID_WIDTH = track.map[0].length;
    const GRID_HEIGHT = track.map.length;
    const CANVAS_WIDTH = GRID_WIDTH * CELL_SIZE;
    const CANVAS_HEIGHT = GRID_HEIGHT * CELL_SIZE;
    ctx.strokeStyle = '#cccccc'; // Light gray for grid lines
    ctx.lineWidth = 0.5;

    // Draw horizontal lines
    for (let y = 0; y <= GRID_HEIGHT; y++) {
        ctx.beginPath();
        ctx.moveTo(0, y * CELL_SIZE);
        ctx.lineTo(CANVAS_WIDTH, y * CELL_SIZE);
        ctx.stroke();
    }

    // Draw vertical lines
    for (let x = 0; x <= GRID_WIDTH; x++) {
        ctx.beginPath();
        ctx.moveTo(x * CELL_SIZE, 0);
        ctx.lineTo(x * CELL_SIZE, CANVAS_HEIGHT);
        ctx.stroke();
    }
}

function drawTrack(ctx, track, CELL_SIZE) {
    const GRID_WIDTH = track.map[0].length;
    const GRID_HEIGHT = track.map.length;
    for (let y = 0; y < GRID_HEIGHT; y++) {
        for (let x = 0; x < GRID_WIDTH; x++) {
            const tile = track.map[y][x];
            ctx.fillStyle = '#ffffff'; // Default to white for '.' (track)

            if (tile === 'X') {
                ctx.fillStyle = '#1f2937'; // Dark gray for 'X' (wall)
            } else if (tile === 'S') {
                ctx.fillStyle = '#d1fae5'; // Light green for Finish/Start area
            } else if (tile === 'A' || tile === 'B') {
                ctx.fillStyle = '#99f6e4'; // Teal for initial start positions
            }
            
            ctx.fillRect(x * CELL_SIZE, y * CELL_SIZE, CELL_SIZE, CELL_SIZE);
            
            // Waypoint markers (1-3) intentionally not drawn to players
        }
    }
}

function drawPossibleMoves(ctx, gameState, myPlayerId, allProjectedMoves, CELL_SIZE) {
    if (!gameState || gameState.currentTurn !== myPlayerId || gameState.status !== 'playing' || !gameState.player2Id) return;
    
    allProjectedMoves.forEach(move => {
        const centerX = move.pos.x * CELL_SIZE;
        const centerY = move.pos.y * CELL_SIZE;

        if (move.isSafe) {
            // Draw Green Dot for Safe Moves
            ctx.beginPath();
            ctx.arc(centerX, centerY, CELL_SIZE / 4, 0, Math.PI * 2);
            ctx.fillStyle = move.isWin ? '#10b981' : '#10b981'; // Green (darker for win)
            ctx.fill();
            
            // Draw velocity line (P->P')
            const playerState = gameState.players.find(p => p.id === myPlayerId);
            ctx.strokeStyle = '#10b981';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(playerState.pos.x * CELL_SIZE, playerState.pos.y * CELL_SIZE);
            ctx.lineTo(centerX, centerY);
            ctx.stroke();

        } else {
            // Draw Red 'X' for Crash/Illegal Moves
            const crashX = (move.crashPos.x + 0.5) * CELL_SIZE;
            const crashY = (move.crashPos.y + 0.5) * CELL_SIZE;
            const size = CELL_SIZE / 3;

            ctx.strokeStyle = '#ef4444'; // Red
            ctx.lineWidth = 2;

            ctx.beginPath();
            ctx.moveTo(crashX - size, crashY - size);
            ctx.lineTo(crashX + size, crashY + size);
            ctx.stroke();

            ctx.beginPath();
            ctx.moveTo(crashX + size, crashY - size);
            ctx.lineTo(crashX - size, crashY + size);
            ctx.stroke();
        }
    });
}

function drawCars(ctx, gameState, CELL_SIZE) {
    if (!gameState) return;

    gameState.players.forEach(player => {
        const color = player.id === 1 ? '#3b82f6' : '#ef4444'; // Blue or Red
        const radius = CELL_SIZE / 3;
        const centerX = player.pos.x * CELL_SIZE;
        const centerY = player.pos.y * CELL_SIZE;

        // Draw Car Body
        ctx.beginPath();
        ctx.arc(centerX, centerY, radius, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();
        
        // Draw outline for definition
        ctx.strokeStyle = '#000000';
        ctx.lineWidth = 1;
        ctx.stroke();

        // Draw velocity vector (P->V)
        if (player.v.dx !== 0 || player.v.dy !== 0) {
            ctx.strokeStyle = color;
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.moveTo(centerX, centerY);
            ctx.lineTo(centerX + player.v.dx * CELL_SIZE, centerY + player.v.dy * CELL_SIZE);
            ctx.stroke();
        }
    });
}

export function render(ctx, track, gameState, myPlayerId, allProjectedMoves, localGameMode, aiPlannedPath, showAIPath, showPlayerPath, playerPlannedPath, lastAISearchSignature, CELL_SIZE) {
    const GRID_WIDTH = track.map[0].length;
    const GRID_HEIGHT = track.map.length;
    const CANVAS_WIDTH = GRID_WIDTH * CELL_SIZE;
    const CANVAS_HEIGHT = GRID_HEIGHT * CELL_SIZE;

    ctx.canvas.width = CANVAS_WIDTH;
    ctx.canvas.height = CANVAS_HEIGHT;

    // 1. Clear and Draw Track
    ctx.clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
    drawTrack(ctx, track, CELL_SIZE);
    drawGrid(ctx, track, CELL_SIZE);

    // 2. Draw Moves (if it's my turn)
    drawPossibleMoves(ctx, gameState, myPlayerId, allProjectedMoves, CELL_SIZE);

    // 2.5 Compute AI planned path if needed (path is null or AI crashed)
    if (localGameMode === 'ai' && gameState && gameState.players && (!aiPlannedPath || aiPlannedPath.length === 0)) {
         const aiState = gameState.players.find(p => p.id === 2);
         if (aiState) {
             // Build a startState for BFS from current AI state
             const startState = { pos: aiState.pos, v: aiState.v, nextWaypointIndex: aiState.nextWaypointIndex };
             console.time('AI Path Calculation');
             const searchResult = findOptimalPath(startState, 100000, 2, gameState, track);
             console.timeEnd('AI Path Calculation');

             aiPlannedPath = (searchResult && searchResult.path) ? searchResult.path : null;
             // Log concise AI search status only when it changes
             const signature = `${startState.pos.x.toFixed(2)}|${startState.pos.y.toFixed(2)}|${startState.v.dx}|${startState.v.dy}|${searchResult ? searchResult.status : 'no_search'}`;
             if (signature !== lastAISearchSignature) {
                 lastAISearchSignature = signature;
                 try {
                     console.log(`AI_SEARCH status=${searchResult ? searchResult.status : 'error'} explored=${searchResult ? searchResult.explored : 0}`);
                 } catch (e) {}
             }
         }
     }

    // Prefer drawing BFS path (green) if available and user wants it
    if (showAIPath) drawAIPath(ctx, aiPlannedPath, gameState, CELL_SIZE);
    if (showAIPath) drawOptimalMove(ctx, gameState, track, aiPlannedPath, CELL_SIZE);

    // If player requested their optimal path, draw it (light orange)
    if (showPlayerPath && gameState) {
        if (playerPlannedPath && playerPlannedPath.length > 0) {
            try {
                ctx.strokeStyle = 'rgba(245,158,11,0.28)'; // amber
                ctx.lineWidth = 2;
                const me = gameState.players.find(p => p.id === myPlayerId);
                ctx.beginPath();
                ctx.moveTo(me.pos.x * CELL_SIZE, me.pos.y * CELL_SIZE);
                for (let step of playerPlannedPath) ctx.lineTo(step.pos.x * CELL_SIZE, step.pos.y * CELL_SIZE);
                ctx.stroke();

                ctx.fillStyle = 'rgba(245,158,11,0.28)';
                for (let step of playerPlannedPath) {
                    ctx.beginPath(); ctx.arc(step.pos.x * CELL_SIZE, step.pos.y * CELL_SIZE, CELL_SIZE / 6, 0, Math.PI * 2); ctx.fill();
                }
            } catch (e) {}
        }
    }

    // 3. Draw Cars (last, so they are on top)
    drawCars(ctx, gameState, CELL_SIZE);
    return { lastAISearchSignature, playerPlannedPath };
}

// Draw the AI's optimal move in a light color so the player can see it
function drawOptimalMove(ctx, gameState, track, aiPlannedPath, CELL_SIZE) {
    if (!gameState) return;
    // Prefer showing a full planned path if available
    if (aiPlannedPath && aiPlannedPath.length > 0) {
        try {
            ctx.strokeStyle = 'rgba(59,130,246,0.35)'; // light blue path
            ctx.lineWidth = 2;
            ctx.beginPath();
            const aiState = gameState.players.find(p => p.id === 2);
            ctx.moveTo(aiState.pos.x * CELL_SIZE, aiState.pos.y * CELL_SIZE);
            for (let step of aiPlannedPath) {
                ctx.lineTo(step.pos.x * CELL_SIZE, step.pos.y * CELL_SIZE);
            }
            ctx.stroke();

            // Draw small dots at each planned step
            ctx.fillStyle = 'rgba(59,130,246,0.28)';
            for (let step of aiPlannedPath) {
                ctx.beginPath();
                ctx.arc(step.pos.x * CELL_SIZE, step.pos.y * CELL_SIZE, CELL_SIZE / 6, 0, Math.PI * 2);
                ctx.fill();
            }
        } catch (e) {}
        return;
    }

    // Fallback to single best move if no planned path
    const best = getBestAIMove(gameState, track);
    if (!best) return;

    // Draw a subtle line and dot for the best move
    try {
        const centerX = best.pos.x * CELL_SIZE;
        const centerY = best.pos.y * CELL_SIZE;
        ctx.strokeStyle = 'rgba(59,130,246,0.45)'; // light blue
        ctx.lineWidth = 2;
        const aiState = gameState.players.find(p => p.id === 2);
        ctx.beginPath();
        ctx.moveTo(aiState.pos.x * CELL_SIZE, aiState.pos.y * CELL_SIZE);
        ctx.lineTo(centerX, centerY);
        ctx.stroke();

        ctx.beginPath();
        ctx.fillStyle = 'rgba(59,130,246,0.35)';
        ctx.arc(centerX, centerY, CELL_SIZE / 4, 0, Math.PI * 2);
        ctx.fill();
    } catch (e) {}
}

export function centerViewOnPlayer(gameState, myPlayerId, canvasContainer, CELL_SIZE) {
    if (!gameState) return;
    const myState = gameState.players.find(p => p.id === myPlayerId);
    if (!myState) return;

    // Target scroll position in pixels
    const targetX = (myState.pos.x * CELL_SIZE) - (canvasContainer.clientWidth / 2);
    const targetY = (myState.pos.y * CELL_SIZE) - (canvasContainer.clientHeight / 2);

    // Smooth scroll to the target position
    canvasContainer.scrollTo({
        left: targetX,
        top: targetY,
        behavior: 'smooth'
    });
}

export function drawEmptyTrack(allTracks) {
    const emptyTrack = allTracks.find(t => t.name === 'Empty Track');
    if (!emptyTrack) return;

    const drawCanvas = document.getElementById('drawCanvas');
    const drawCtx = drawCanvas.getContext('2d');
    const mapLines = emptyTrack.configString.trim().split('\n').map(line => line.trim());
    const gridHeight = mapLines.length;
    const gridWidth = mapLines[0].length;
    const cellSize = 12;

    drawCanvas.width = gridWidth * cellSize;
    drawCanvas.height = gridHeight * cellSize;

    for (let y = 0; y < gridHeight; y++) {
        for (let x = 0; x < gridWidth; x++) {
            const tile = mapLines[y][x];
            drawCtx.fillStyle = tile === 'X' ? '#1f2937' : '#ffffff';
            drawCtx.fillRect(x * cellSize, y * cellSize, cellSize, cellSize);
        }
    }
}
