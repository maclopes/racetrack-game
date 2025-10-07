import { PREF_SHOW_AI_PATH, PREF_SHOW_PLAYER_PATH, ACCELERATIONS } from './config.js';
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

const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');
const canvasContainer = document.getElementById('canvasContainer');
let CELL_SIZE = 12;

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
        drawEmptyTrack(ALL_TRACKS);
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
}