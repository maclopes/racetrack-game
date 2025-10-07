import { generateGameHash } from './utils.js';
import { getInitialVelocity } from './game-mechanics.js';
import { loadTrackConfig } from './file-loading.js';
import { showView, updateUI } from './ui.js';

export async function initFirebase(loadFirebaseConfig) {
    let firebaseConfig = await loadFirebaseConfig();
    if (!firebaseConfig || !firebaseConfig.projectId) {
        console.error('Firebase config missing after loadFirebaseConfig(). See config.example.json.');
        return null;
    }
    
    try { firebase.setLogLevel('error'); } catch (e) {}

    const app = firebase.initializeApp(firebaseConfig);
    const db = firebase.getFirestore(app);
    const auth = firebase.getAuth(app);

    return { app, db, auth };
}

export function setupGameListener(hash, db, allTracks, track, canvas, canvasContainer, updateUI, render) {
    let gameListener = null;
    const gameRef = firebase.doc(db, `artifacts/default-app-id/public/data/racetrack_games/${hash}`);

    gameListener = firebase.onSnapshot(gameRef, (docSnap) => {
        if (docSnap.exists()) {
            const remoteGameState = docSnap.data();
            if (remoteGameState.trackConfigString && (!gameState || gameState.trackConfigString !== remoteGameState.trackConfigString)) {
                allTracks.push({ name: "Online Game Track", configString: remoteGameState.trackConfigString });
                loadTrackConfig(allTracks.length - 1, allTracks, track, canvas, canvasContainer);
            }
            let gameState = docSnap.data();
            gameState.gameHash = hash; 
            
            if (gameState.player1Id === userId) {
                myPlayerId = 1;
            } else if (gameState.player2Id === userId) {
                myPlayerId = 2;
            } else {
                console.error("User not registered as P1 or P2 in this game.");
                return;
            }

            showView('gameView');
            const opponent = gameState.players.find(p => p.id !== myPlayerId);
            if (opponent && aiPlannedPath) {
                for (const step of aiPlannedPath) {
                    if (Math.abs(step.pos.x - opponent.pos.x) < 0.1 && Math.abs(step.pos.y - opponent.pos.y) < 0.1) {
                        aiPlannedPath = null; 
                        break;
                    }
                }
            }
            playerPlannedPath = null; 
            updateUI(gameState, myPlayerId);
            render();

        } else {
            console.log("Game deleted or not found.");
            gameState = null;
            gameHash = null;
            myPlayerId = null;
            showView('lobbyView');
        }
    }, (error) => {
        console.error("Firestore error:", error);
    });
    return gameListener;
}

export async function createGame(db, userId, track, allTracks, selectedTrackIndex) {
    document.getElementById('createSpinner').style.display = 'inline';
    
    const newHash = generateGameHash();
    const p1Start = track.startPositions.player1;
    const p2Start = track.startPositions.player2;
    const selectedTrackConfig = allTracks[selectedTrackIndex].configString;
    
    const initialV = getInitialVelocity();

    const newGameState = {
        gameHash: newHash,
        status: 'lobby',
        currentTurn: 1,
        player1Id: userId,
        player2Id: null,
        trackConfigString: selectedTrackConfig,
        players: [
            { id: 1, pos: p1Start, prevPos: p1Start, v: initialV, nextWaypointIndex: 0, safe: true, skipTurns: 0 },
            { id: 2, pos: p2Start, prevPos: p2Start, v: initialV, nextWaypointIndex: 0, safe: true, skipTurns: 0 }
        ]
    };

    try {
        const gameRef = firebase.doc(db, `artifacts/default-app-id/public/data/racetrack_games/${newHash}`);
        await firebase.setDoc(gameRef, newGameState);
        return newHash;
    } catch (error) {
        console.error("Error creating game:", error);
    } finally {
        document.getElementById('createSpinner').style.display = 'none';
    }
    return null;
}

export async function joinGame(hash, db, userId, customConfirm) {
    const gameRef = firebase.doc(db, `artifacts/default-app-id/public/data/racetrack_games/${hash}`);
    try {
        const docSnap = await firebase.getDoc(gameRef);

        if (docSnap.exists()) {
            const existingGame = docSnap.data();

            if (existingGame.player2Id === null) {
                await firebase.updateDoc(gameRef, {
                    player2Id: userId,
                    status: 'playing'
                });
                return hash;
            } else if (existingGame.player1Id === userId || existingGame.player2Id === userId) {
                return hash;
            } else {
                await customConfirm(`Game ${hash} is already full. Please find another game or create your own.`);
            }
        } else {
            await customConfirm(`Game ID ${hash} not found.`);
        }

    } catch (error) {
        console.error("Error joining game:", error);
        await customConfirm("An error occurred while joining the game.");
    }
    return null;
}

export async function resetGame(gameState, gameHash, myPlayerId, db, customConfirm) {
    if (!gameState || !gameHash) return;

    const confirmMessage = myPlayerId === 1 && gameState.player2Id
        ? `Are you sure you want to delete game ${gameHash}? This will end the game for both players.`
        : `Are you sure you want to forfeit this game and start a new one?`;

    const confirmed = await customConfirm(confirmMessage);
    if (!confirmed) return;

    try {
        const gameRef = firebase.doc(db, `artifacts/default-app-id/public/data/racetrack_games/${gameHash}`);
        
        if (myPlayerId === 1 && gameState.player2Id) {
            await firebase.deleteDoc(gameRef);
        } else {
            return true; // P2 forfeits or P1 forfeits an empty game
        }
    } catch (error) {
        console.error("Error resetting game:", error);
    }
    return false;
}