import { PREF_SHOW_AI_PATH, PREF_SHOW_PLAYER_PATH, ACCELERATIONS, WAYPOINT_SEQUENCE, BFS_MAX_STEPS } from './config.js';
import { generateGameHash, customConfirm } from './utils.js';
import { loadFirebaseConfig, loadAllTracks, loadTrackConfig, computeAndSaveHeuristics } from './file-loading.js';
import { getInitialVelocity, getProjectedMove } from './game-mechanics.js';
import { findOptimalPath, aiMakeMove } from './ai.js';
import { showView, updateUI, render, centerViewOnPlayer, drawEmptyTrack } from './ui.js';
import { initFirebase, setupGameListener, createGame, joinGame, resetGame } from './firebase.js';
import { applyMove } from './game-mechanics.js';

// --- Global Variables ---
let app, db, auth;
let userId = null;
let gameListener = null;
let firebaseInitialized = false;

let gameState = null;
let myPlayerId = null;
let gameHash = null;
let localGameMode = null;
let aiThinkingTimeout = null;

let ALL_TRACKS = [];
let selectedTrackIndex = 0;

let track = { map: [], startPositions: { player1: null, player2: null }, waypoints: {} };
let allProjectedMoves = [];
let aiPlannedPath = null;
let playerPlannedPath = null;
let lastAISearchSignature = null;

let showAIPath = localStorage.getItem(PREF_SHOW_AI_PATH) === 'true';
let showPlayerPath = localStorage.getItem(PREF_SHOW_PLAYER_PATH) === 'true';

let drawnPoints = []; // For the track drawing view
let drawingTrackMap = []; // For the track drawing view
let isDrawingFinished = false; // For the track drawing view
const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');
const canvasContainer = document.getElementById('canvasContainer');
let CELL_SIZE = 12;

function bresenhamLine(x0, y0, x1, y1) {
    const points = [];
    let dx = Math.abs(x1 - x0);
    let dy = -Math.abs(y1 - y0);
    let sx = x0 < x1 ? 1 : -1;
    let sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;

    while (true) {
        points.push({ x: x0, y: y0 });
        if (x0 === x1 && y0 === y1) break;
        let e2 = 2 * err;
        if (e2 >= dy) {
            err += dy;
            x0 += sx;
        }
        if (e2 <= dx) {
            err += dx;
            y0 += sy;
        }
    }
    return points;
}

function carveTrack(lastPoint, newPoint) {
    const lineCells = bresenhamLine(lastPoint.x, lastPoint.y, newPoint.x, newPoint.y);
    const gridHeight = drawingTrackMap.length;
    const gridWidth = drawingTrackMap[0].length;

    for (let y = 0; y < gridHeight; y++) {
        for (let x = 0; x < gridWidth; x++) {
            if (lineCells.some(p => Math.abs(p.x - x) + Math.abs(p.y - y) <= 2)) {
                // Ensure we don't carve into the 2-cell border
                if (x > 1 && x < gridWidth - 2 && y > 1 && y < gridHeight - 2) {
                    if (!['A', 'B', 'S'].includes(drawingTrackMap[y][x])) {
                        drawingTrackMap[y][x] = '.';
                    }
                }
            }
        }
    }
}

function placeStartFinishLine(p1, p2) {
    const dx = p2.x - p1.x;
    const dy = p2.y - p1.y;

    // Get a normalized perpendicular vector. This points "left" of the drawing direction.
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len === 0) return; // Avoid division by zero if points are the same
    const perpDx = -dy / len;
    const perpDy = dx / len;

    // Define the positions for S, A, B relative to the first point (p1)
    const positions = {
        'A': { x: p1.x, y: p1.y },
        'B': { x: p1.x + perpDx, y: p1.y + perpDy },
        'S_left': { x: p1.x + 2 * perpDx, y: p1.y + 2 * perpDy },
        'S_right': { x: p1.x - perpDx, y: p1.y - perpDy }
    };

    const gridHeight = drawingTrackMap.length;
    const gridWidth = drawingTrackMap[0].length;

    // Place the markers on the map
    const placeMarker = (char, pos) => {
        const gridX = Math.round(pos.x);
        const gridY = Math.round(pos.y);
        if (gridX > 1 && gridX < gridWidth - 2 && gridY > 1 && gridY < gridHeight - 2) {
            drawingTrackMap[gridY][gridX] = char;
        }
    };

    placeMarker('A', positions.A);
    placeMarker('B', positions.B);
    placeMarker('S', positions.S_left);
    placeMarker('S', positions.S_right);
}

function placeWaypointLine(pointIndex, waypointChar) {
    if (pointIndex <= 0 || pointIndex >= drawnPoints.length - 1) return;

    const p1 = drawnPoints[pointIndex];
    const p2 = drawnPoints[pointIndex + 1];

    const dx = p2.x - p1.x;
    const dy = p2.y - p1.y;

    const len = Math.sqrt(dx * dx + dy * dy);
    if (len === 0) return;
    const perpDx = -dy / len;
    const perpDy = dx / len;

    const gridHeight = drawingTrackMap.length;
    const gridWidth = drawingTrackMap[0].length;

    // Draw a line of waypoints perpendicular to the track direction
    for (let i = -2; i <= 2; i++) {
        const gridX = Math.round(p1.x + i * perpDx);
        const gridY = Math.round(p1.y + i * perpDy);

        if (gridX > 1 && gridX < gridWidth - 2 && gridY > 1 && gridY < gridHeight - 2) {
            if (drawingTrackMap[gridY][gridX] === '.') {
                drawingTrackMap[gridY][gridX] = waypointChar;
            }
        }
    }
}

function validateDrawnTrack() {
    const validationMsgEl = document.getElementById('validationMessage');
    validationMsgEl.textContent = 'Validating...';
    validationMsgEl.className = 'text-center font-semibold p-3 rounded-lg bg-yellow-100 text-yellow-800';

    // 1. Build a 'track' object from the drawing data
    const newTrack = {
        map: drawingTrackMap,
        waypoints: {},
        startPositions: { player1: null, player2: null }
    };

    for (let y = 0; y < drawingTrackMap.length; y++) {
        for (let x = 0; x < drawingTrackMap[y].length; x++) {
            const tile = drawingTrackMap[y][x];
            if (tile === 'A') newTrack.startPositions.player1 = { x: x + 0.5, y: y + 0.5 };
            if (tile === 'B') newTrack.startPositions.player2 = { x: x + 0.5, y: y + 0.5 };
            if (WAYPOINT_SEQUENCE.includes(tile) || tile === 'S') {
                if (!newTrack.waypoints[tile]) newTrack.waypoints[tile] = [];
                newTrack.waypoints[tile].push({ x: x + 0.5, y: y + 0.5 });
            }
        }
    }

    if (!newTrack.startPositions.player1 || !newTrack.startPositions.player2) {
        validationMsgEl.textContent = 'Validation Failed: Missing start positions A or B.';
        validationMsgEl.className = 'text-center font-semibold p-3 rounded-lg bg-red-100 text-red-800';
        return;
    }

    // 2. Create a mock gameState to run the validator
    const mockGameState = {
        currentTurn: 2,
        players: [
            { id: 1, pos: newTrack.startPositions.player1, v: getInitialVelocity(), nextWaypointIndex: 0 },
            { id: 2, pos: newTrack.startPositions.player2, v: getInitialVelocity(), nextWaypointIndex: 0 }
        ]
    };

    // 3. Run the pathfinder from player B's perspective
    const startState = {
        pos: newTrack.startPositions.player2,
        v: getInitialVelocity(),
        nextWaypointIndex: 0
    };

    // Use a timeout to allow the UI to update to "Validating..." before the potentially long-running search
    setTimeout(() => {
        const result = findOptimalPath(startState, BFS_MAX_STEPS, 2, mockGameState, newTrack);

        if (result && result.path) {
            validationMsgEl.textContent = `Track is valid! Optimal path found in ${result.path.length} turns.`;
            validationMsgEl.className = 'text-center font-semibold p-3 rounded-lg bg-green-100 text-green-800';
            document.getElementById('saveTrackBtn').classList.remove('hidden');
            drawEmptyTrack(drawingTrackMap, drawnPoints, result.path, newTrack.startPositions.player2);
        } else {
            validationMsgEl.textContent = `Validation Failed: No optimal path found. The track may be impossible. (Status: ${result.status})`;
            validationMsgEl.className = 'text-center font-semibold p-3 rounded-lg bg-red-100 text-red-800';
        }
    }, 50);
}

function printPlayersState(context) {
    try {
        console.log(`STATE [${context}] game=${gameHash} mode=${localGameMode}`);
        if (!gameState) { console.log('STATE gameState = null'); return; }
        gameState.players.forEach(p => {
            console.log(`  P${p.id} pos=(${p.pos.x.toFixed(2)},${p.pos.y.toFixed(2)}) v=(${p.v.dx},${p.v.dy}) wp=${p.nextWaypointIndex} safe=${p.safe}`);
        });
    } catch (e) {
        console.error('STATE printPlayersState error', e);
    }
}

function calculatePossibleMoves() {
    allProjectedMoves = [];
    
    if (!gameState || gameState.currentTurn !== myPlayerId) return;

    const myState = gameState.players.find(p => p.id === myPlayerId);
    if (!myState) return;

    const mockPlayerState = {
        pos: myState.pos,
        v: myState.v,
        nextWaypointIndex: myState.nextWaypointIndex,
        prevPos: myState.prevPos
    };

    ACCELERATIONS.forEach(accel => {
        allProjectedMoves.push(getProjectedMove(mockPlayerState, accel.ax, accel.ay, myPlayerId, gameState, track));
    });
}

function handleCanvasClick(event) {
    if (!gameState || gameState.currentTurn !== myPlayerId || gameState.status !== 'playing' || !gameState.player2Id) {
        return;
    }

    const xGrid = event.offsetX / CELL_SIZE;
    const yGrid = event.offsetY / CELL_SIZE;

    const clickTolerance = 0.25;

    for (const move of allProjectedMoves) {
        let targetPos;

        if (move.isSafe) {
            targetPos = move.pos;
        } else {
            targetPos = { x: move.crashPos.x + 0.5, y: move.crashPos.y + 0.5 };
        }

        const distance = Math.sqrt(
            Math.pow(xGrid - targetPos.x, 2) + Math.pow(yGrid - targetPos.y, 2)
        );

        if (distance < clickTolerance) {
            if (playerPlannedPath && playerPlannedPath.length > 0) {
                const plannedMove = playerPlannedPath[0].move;
                if (plannedMove.ax !== move.ax || plannedMove.ay !== move.ay) {
                    playerPlannedPath = null;
                }
            }
            if (playerPlannedPath) playerPlannedPath.shift();
            applyMoveWrapper(move);
            return; 
        }
    }
}

function startLocalGame() {
    if (!track.startPositions.player1 || !track.startPositions.player2) {
        customConfirm("The selected track is missing start positions. Please select a track with 'A' and 'B' markers.");
        return;
    }
    localGameMode = 'local';
    loadTrackConfig(selectedTrackIndex, ALL_TRACKS, track, canvas, canvasContainer);
    const newHash = generateGameHash();
    const p1Start = track.startPositions.player1;
    const p2Start = track.startPositions.player2;
    const initialV = getInitialVelocity();

    gameHash = newHash;
    gameState = {
        gameHash: newHash,
        status: 'playing',
        currentTurn: 1,
        player1Id: 'LOCAL_P1',
        player2Id: 'LOCAL_P2',
        players: [
            { id: 1, pos: p1Start, prevPos: p1Start, v: initialV, nextWaypointIndex: 0, safe: true, skipTurns: 0 },
            { id: 2, pos: p2Start, prevPos: p2Start, v: initialV, nextWaypointIndex: 0, safe: true, skipTurns: 0 }
        ]
    };
    myPlayerId = 1;
    aiPlannedPath = null;
    showView('gameView');
    updateUIWrapper();
    renderWrapper();
    centerViewOnPlayerWrapper();
}

function startAIGame() {
    if (!track.startPositions.player1 || !track.startPositions.player2) {
        customConfirm("The selected track is missing start positions. Please select a track with 'A' and 'B' markers.");
        return;
    }
    localGameMode = 'ai';
    loadTrackConfig(selectedTrackIndex, ALL_TRACKS, track, canvas, canvasContainer);
    const newHash = generateGameHash();
    const p1Start = track.startPositions.player1;
    const p2Start = track.startPositions.player2;
    const initialV = getInitialVelocity();

    gameHash = newHash;
    gameState = {
        gameHash: newHash,
        status: 'playing',
        currentTurn: 1,
        player1Id: 'HUMAN_P1',
        player2Id: 'AI',
        players: [
            { id: 1, pos: p1Start, prevPos: p1Start, v: initialV, nextWaypointIndex: 0, safe: true, skipTurns: 0 },
            { id: 2, pos: p2Start, prevPos: p2Start, v: initialV, nextWaypointIndex: 0, safe: true, skipTurns: 0 }
        ]
    };
    myPlayerId = 1;
    aiPlannedPath = null;
    showView('gameView');
    updateUIWrapper();
    renderWrapper();
    centerViewOnPlayerWrapper();
}

async function applyMoveWrapper(move, actorId = null) {
    const result = await applyMove(move, actorId, gameState, gameHash, db, localGameMode, myPlayerId, aiMakeMoveWrapper, aiThinkingTimeout);
    if (result && result.newGameState) {
        gameState = result.newGameState;
        aiThinkingTimeout = result.aiThinkingTimeout;
        if (localGameMode === 'local') {
            myPlayerId = gameState.currentTurn;
        }
        updateUIWrapper();
    }
}

function aiMakeMoveWrapper() {
    aiMakeMove(gameState, track, applyMoveWrapper, aiPlannedPath);
}

function updateUIWrapper() {
    updateUI(gameState, myPlayerId);
    renderWrapper();
    centerViewOnPlayerWrapper();
}

function renderWrapper() {
    calculatePossibleMoves();
    const result = render(ctx, track, gameState, myPlayerId, allProjectedMoves, localGameMode, aiPlannedPath, showAIPath, showPlayerPath, playerPlannedPath, lastAISearchSignature, CELL_SIZE);
    lastAISearchSignature = result.lastAISearchSignature;
    playerPlannedPath = result.playerPlannedPath;
}

function centerViewOnPlayerWrapper() {
    centerViewOnPlayer(gameState, myPlayerId, canvasContainer);
}

window.onload = async function() {
    const trackData = await loadAllTracks(track, canvas, canvasContainer);
    ALL_TRACKS = trackData.ALL_TRACKS;
    selectedTrackIndex = trackData.selectedTrackIndex;
    loadTrackConfig(selectedTrackIndex, ALL_TRACKS, track, canvas, canvasContainer);
    renderWrapper();
    document.getElementById('connectionStatus').textContent = 'Ready to play.';
    showView('lobbyView');

    document.getElementById('createGameBtn').addEventListener('click', async () => {
        if (!firebaseInitialized) {
            const firebaseObjects = await initFirebase(loadFirebaseConfig);
            if(firebaseObjects) {
                app = firebaseObjects.app;
                db = firebaseObjects.db;
                auth = firebaseObjects.auth;
                firebaseInitialized = true;
            }
        }
        const newHash = await createGame(db, userId, track, ALL_TRACKS, selectedTrackIndex);
        if (newHash) {
            gameHash = newHash;
            gameListener = setupGameListener(gameHash, db, ALL_TRACKS, track, canvas, canvasContainer, updateUIWrapper, renderWrapper);
            localGameMode = 'online';
        }
    });
    document.getElementById('drawTrackBtn').addEventListener('click', () => {
        drawnPoints = [];
        isDrawingFinished = false;
        document.getElementById('saveTrackBtn').classList.add('hidden');
        document.getElementById('validationMessage').textContent = '';
        const emptyTrack = ALL_TRACKS.find(t => t.name === 'Empty Track');
        if (emptyTrack) {
            drawingTrackMap = emptyTrack.configString.trim().split('\n').map(line => Array.from(line.trim()));
        }
        drawEmptyTrack(drawingTrackMap, drawnPoints);
        showView('drawTrackView');
    });
    document.getElementById('backToLobbyBtn').addEventListener('click', () => showView('lobbyView'));
    document.getElementById('localGameBtn').addEventListener('click', startLocalGame);
    document.getElementById('playAIBtn').addEventListener('click', startAIGame);
    document.getElementById('downloadHeuristicsBtn').addEventListener('click', () => computeAndSaveHeuristics(track, canvas));
    document.getElementById('joinGameForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const hash = document.getElementById('gameIdInput').value.toUpperCase().trim();
        if (hash.length === 5) {
            if (!firebaseInitialized) {
                const firebaseObjects = await initFirebase(loadFirebaseConfig);
                if(firebaseObjects) {
                    app = firebaseObjects.app;
                    db = firebaseObjects.db;
                    auth = firebaseObjects.auth;
                    firebaseInitialized = true;
                }
            }
            const joinedHash = await joinGame(hash, db, userId, customConfirm);
            if (joinedHash) {
                gameHash = joinedHash;
                gameListener = setupGameListener(gameHash, db, ALL_TRACKS, track, canvas, canvasContainer, updateUIWrapper, renderWrapper);
                localGameMode = 'online';
            }
        }
    });
    document.getElementById('resetButton').addEventListener('click', async () => {
        const forfeited = await resetGame(gameState, gameHash, myPlayerId, db, customConfirm);
        if (forfeited) {
            gameState = null;
            gameHash = null;
            myPlayerId = null;
            if (gameListener) gameListener();
            showView('lobbyView');
        }
    });
    canvas.addEventListener('click', handleCanvasClick);
    
    canvasContainer.addEventListener('wheel', (e) => {
        e.preventDefault();
        const newCellSize = CELL_SIZE + (e.deltaY < 0 ? 1 : -1);
        CELL_SIZE = Math.min(Math.max(10, newCellSize), 30);        
        renderWrapper();
        centerViewOnPlayerWrapper();
    });

    const aiCheckbox = document.getElementById('showAIPathCheckbox');
    const playerCheckbox = document.getElementById('showPlayerPathCheckbox');
    if (aiCheckbox) {
        aiCheckbox.checked = showAIPath;
        aiCheckbox.addEventListener('change', (e) => {
            showAIPath = e.target.checked;
            localStorage.setItem(PREF_SHOW_AI_PATH, showAIPath ? 'true' : 'false');
            try { renderWrapper(); } catch (err) {}
        });
    }
    if (playerCheckbox) {
        playerCheckbox.checked = showPlayerPath;
        playerCheckbox.addEventListener('change', (e) => {
            showPlayerPath = e.target.checked;
            localStorage.setItem(PREF_SHOW_PLAYER_PATH, showPlayerPath ? 'true' : 'false');
            if (showPlayerPath && gameState) {
                const myState = gameState.players.find(p => p.id === myPlayerId);
                if (myState) {
                    console.time('Player Path Calculation (Checkbox)');
                    const res = findOptimalPath({ pos: myState.pos, v: myState.v, nextWaypointIndex: myState.nextWaypointIndex }, 100000, myPlayerId, gameState, track);
                    console.timeEnd('Player Path Calculation (Checkbox)');

                    playerPlannedPath = res && res.path ? res.path : null;
                }
            } else {
                playerPlannedPath = null;
            }
            try { renderWrapper(); } catch (err) {}
        });
    }

    const drawCanvas = document.getElementById('drawCanvas');
    drawCanvas.addEventListener('click', (event) => {
        if (isDrawingFinished) return; // Ignore clicks if drawing is complete

        const cellSize = 12; // This is hardcoded in drawEmptyTrack
        const rect = drawCanvas.getBoundingClientRect();
        const x = event.clientX - rect.left;
        const y = event.clientY - rect.top;

        const gridX = Math.floor(x / cellSize);
        const gridY = Math.floor(y / cellSize);

        // Check if clicking on the start/finish line to close the loop
        if (drawnPoints.length > 2 && ['S', 'A', 'B'].includes(drawingTrackMap[gridY][gridX])) {
            const lastPoint = drawnPoints[drawnPoints.length - 1];
            const firstPoint = drawnPoints[0];
            carveTrack(lastPoint, firstPoint);

            placeWaypointLine(Math.floor(drawnPoints.length * 0.25), '1');
            placeWaypointLine(Math.floor(drawnPoints.length * 0.50), '2');
            placeWaypointLine(Math.floor(drawnPoints.length * 0.75), '3');

            isDrawingFinished = true;
            drawEmptyTrack(drawingTrackMap, drawnPoints); // Redraw final track
            validateDrawnTrack();
            return;
        }

        if (drawnPoints.length > 0) {
            const lastPoint = drawnPoints[drawnPoints.length - 1];
            const manhattanDistance = Math.abs(gridX - lastPoint.x) + Math.abs(gridY - lastPoint.y);
            if (manhattanDistance > 6) {
                console.log(`Move too large (Manhattan distance: ${manhattanDistance}). From {x:${lastPoint.x}, y:${lastPoint.y}} to {x:${gridX}, y:${gridY}}. Ignoring.`);
                return; // Ignore click if distance is too great
            }
            if (drawnPoints.length === 1) {
                placeStartFinishLine(lastPoint, { x: gridX, y: gridY });
            }
            carveTrack(lastPoint, { x: gridX, y: gridY });
        }

        drawnPoints.push({ x: gridX, y: gridY });
        drawEmptyTrack(drawingTrackMap, drawnPoints); // Redraw with the new point/line
    });

    drawCanvas.addEventListener('contextmenu', (event) => {
        event.preventDefault(); // Prevent the default right-click menu
        if (drawnPoints.length > 0) {
            drawnPoints.pop(); // Remove the last point
            // Note: This doesn't "undo" the carving, just removes the point/line visually.
            // A full undo would require saving map states.
            drawEmptyTrack(drawingTrackMap, drawnPoints); // Redraw the track
        }
    });

    document.getElementById('saveTrackBtn').addEventListener('click', () => {
        if (!drawingTrackMap || drawingTrackMap.length === 0) {
            console.error("No track data to save.");
            return;
        }

        const trackName = `::Track Custom ${new Date().toISOString().slice(0, 10)}\n`;
        const trackString = drawingTrackMap.map(row => row.join('')).join('\n');
        const fileContent = trackName + trackString + '\n';

        const blob = new Blob([fileContent], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'custom-track.txt';
        a.click();
        URL.revokeObjectURL(url);
    });
}