import { WAYPOINT_SEQUENCE } from './config.js';

export async function loadFirebaseConfig() {
    // Use the in-page config object. Check if it has been replaced by the CI/CD pipeline.
    if (window.__FIREBASE_CONFIG__ && window.__FIREBASE_CONFIG__.projectId !== "__FIREBASE_PROJECT_ID__") {
        console.log('Firebase config: using window.__FIREBASE_CONFIG__');
        return window.__FIREBASE_CONFIG__;
    }

    // Not found — provide actionable guidance both in console and UI
    console.error('Firebase config not found or not replaced by the deployment workflow.');
    // Update the connectionStatus element with actionable steps
    try {
        const el = document.getElementById('connectionStatus');
        if (el) {
            el.textContent = 'ERROR: Firebase config missing. This page must be built via the CI/CD workflow.';
        }
    } catch (e) {}
    return null;
}

export function loadTrackConfig(trackIndex, allTracks, track, canvas, canvasContainer) {
    if (trackIndex === undefined || !allTracks[trackIndex]) {
        console.error("Invalid track index provided to loadTrackConfig.");
        return;
    }
    const TRACK_CONFIG_STRING = allTracks[trackIndex].configString;

    // Parses the ASCII track string and initializes the track map and dimensions.
    try {
        const mapLines = TRACK_CONFIG_STRING.trim().split('\n').map(line => line.trim()).filter(line => line.length > 0);
        
        track.waypoints = {};
        track.map = [];
        track.startPositions = { player1: null, player2: null };
        const GRID_HEIGHT = mapLines.length;
        const GRID_WIDTH = mapLines[0].length;
        
        const CELL_SIZE = 12;
        const CANVAS_WIDTH = GRID_WIDTH * CELL_SIZE;
        const CANVAS_HEIGHT = GRID_HEIGHT * CELL_SIZE;
        canvas.width = CANVAS_WIDTH;
        canvas.height = CANVAS_HEIGHT;
        
        // Adjust container size for scroll
        canvasContainer.style.width = `${CANVAS_WIDTH}px`;
        canvasContainer.style.height = `${CANVAS_HEIGHT}px`;


        for (let y = 0; y < GRID_HEIGHT; y++) {
            let line = mapLines[y];
            if (line.length !== GRID_WIDTH) {
                 line = line.padEnd(GRID_WIDTH, 'X').substring(0, GRID_WIDTH);
            }
            track.map.push(Array.from(line));
            
            for (let x = 0; x < GRID_WIDTH; x++) {
                // Use a fixed point for initial rendering/centering if A/B are off screen
                if (line[x] === 'A') {
                    track.startPositions.player1 = { x: x + 0.5, y: y + 0.5 };
                } else if (line[x] === 'B') {
                    track.startPositions.player2 = { x: x + 0.5, y: y + 0.5 };
                }
                // Pre-calculate waypoint and finish line coordinates for the A* heuristic
                const tile = line[x];
                if (WAYPOINT_SEQUENCE.includes(tile) || tile === 'S') {
                    if (!track.waypoints[tile]) {
                        track.waypoints[tile] = [];
                    }
                    track.waypoints[tile].push({ x: x + 0.5, y: y + 0.5 });
                }
            }
        }
    } catch (error) {
        console.error("Error loading track configuration:", error);
    }
}

export async function loadAllTracks(track, canvas, canvasContainer) {
    let ALL_TRACKS = [];
    let selectedTrackIndex = 0;
    try {
        const response = await fetch('tracks.txt');
        if (!response.ok) {
            console.error("Could not fetch tracks.txt");
            return;
        }
        const text = await response.text();
        // Split by the track delimiter '::Track '. The filter(Boolean) removes any empty initial string.
        const trackChunks = text.trim().split(/\n?::Track /).filter(Boolean);

        ALL_TRACKS = trackChunks.map(chunk => {
            const lines = chunk.trim().split('\n');
            const name = lines.shift().trim(); // The first line after the delimiter is the name
            const configString = lines.join('\n');
            return { name, configString, previewImageURL: null };
        });

        // Generate previews and populate UI
        const container = document.getElementById('trackSelectionContainer');
        container.innerHTML = ''; // Clear previous content

        ALL_TRACKS.forEach((trackData, index) => {
            // Generate preview image
            const mapLines = trackData.configString.trim().split('\n');
            const previewWidth = mapLines[0].length * 2; // 2px per cell
            const previewHeight = mapLines.length * 2;
            const previewCanvas = document.createElement('canvas');
            previewCanvas.width = previewWidth;
            previewCanvas.height = previewHeight;
            const pCtx = previewCanvas.getContext('2d');
            for (let y = 0; y < mapLines.length; y++) {
                for (let x = 0; x < mapLines[y].length; x++) {
                    pCtx.fillStyle = mapLines[y][x] === 'X' ? '#1f2937' : '#d1d5db';
                    pCtx.fillRect(x * 2, y * 2, 2, 2);
                }
            }
            trackData.previewImageURL = previewCanvas.toDataURL();

            // Create UI element
            const trackElement = document.createElement('div');
            trackElement.className = `p-2 border-2 rounded-lg cursor-pointer transition ${index === selectedTrackIndex ? 'border-blue-600 bg-blue-50' : 'border-gray-300'}`;
            trackElement.innerHTML = `
                <img src="${trackData.previewImageURL}" class="w-full h-auto rounded-md border border-gray-400" style="image-rendering: pixelated;"/>
                <p class="text-center font-semibold mt-2 text-gray-800">${trackData.name}</p>
            `;
            trackElement.addEventListener('click', () => {
                loadTrackConfig(index, ALL_TRACKS, track, canvas, canvasContainer);
                selectedTrackIndex = index;
                // Update selection visuals
                document.querySelectorAll('#trackSelectionContainer > div').forEach((el, i) => {
                    el.className = `p-2 border-2 rounded-lg cursor-pointer transition ${i === index ? 'border-blue-600 bg-blue-50' : 'border-gray-300'}`;
                });
            });
            container.appendChild(trackElement);
        });
        return { ALL_TRACKS, selectedTrackIndex };
    } catch (error) { 
        console.error("Error loading all tracks:", error); 
        return { ALL_TRACKS: [], selectedTrackIndex: 0 };
    }
}

export function computeAndSaveHeuristics(track, canvas) {
    const allHeuristics = {};
    const allGoals = [...WAYPOINT_SEQUENCE, 'S'];
    const GRID_WIDTH = track.map[0].length;
    const GRID_HEIGHT = track.map.length;
    const CELL_SIZE = 12;
    const CANVAS_WIDTH = GRID_WIDTH * CELL_SIZE;
    const CANVAS_HEIGHT = GRID_HEIGHT * CELL_SIZE;

    for (const goal of allGoals) {
        const targetTiles = track.waypoints[goal] || [];
        if (targetTiles.length === 0) continue;

        const grid = Array(GRID_HEIGHT).fill(null).map(() => Array(GRID_WIDTH).fill(null));
        let maxHeuristic = 0; // For color normalization

        for (let y = 0; y < GRID_HEIGHT; y++) {
            for (let x = 0; x < GRID_WIDTH; x++) {
                if (track.map[y][x] === 'X') {
                    grid[y][x] = -1; // Use -1 to indicate an impassable wall
                    continue;
                }

                let minDistance = Infinity;
                for (const target of targetTiles) {
                    const dist = Math.abs((x + 0.5) - target.x) + Math.abs((y + 0.5) - target.y);
                    if (dist < minDistance) minDistance = dist;
                }
                
                // Store the raw integer Manhattan distance.
                const h = Math.round(minDistance);
                grid[y][x] = h;
                if (h > maxHeuristic) maxHeuristic = h;
            }
        }
        allHeuristics[goal] = grid;

        // --- Generate and download an image for this heuristic map ---
        const offscreenCanvas = document.createElement('canvas');
        offscreenCanvas.width = CANVAS_WIDTH;
        offscreenCanvas.height = CANVAS_HEIGHT;
        const offscreenCtx = offscreenCanvas.getContext('2d');

        for (let y = 0; y < GRID_HEIGHT; y++) {
            for (let x = 0; x < GRID_WIDTH; x++) {
                const hValue = grid[y][x];
                if (hValue === -1) {
                    offscreenCtx.fillStyle = '#1f2937'; // Wall color
                } else {
                    const normalizedH = hValue / maxHeuristic;
                    // Color from green (low heuristic) to red (high heuristic)
                    const r = Math.floor(255 * normalizedH);
                    const g = Math.floor(255 * (1 - normalizedH));
                    offscreenCtx.fillStyle = `rgb(${r}, ${g}, 0)`;
                }
                offscreenCtx.fillRect(x * CELL_SIZE, y * CELL_SIZE, CELL_SIZE, CELL_SIZE);
            }
        }

        const imgDataUrl = offscreenCanvas.toDataURL('image/png');
        const imgDownloadAnchor = document.createElement('a');
        imgDownloadAnchor.setAttribute("href", imgDataUrl);
        imgDownloadAnchor.setAttribute("download", `heuristic_map_goal_${goal}.png`);
        document.body.appendChild(imgDownloadAnchor);
        imgDownloadAnchor.click();
        imgDownloadAnchor.remove();
    }

    // Create a downloadable text file with the heuristic data
    const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(allHeuristics, null, 2));
    const downloadAnchorNode = document.createElement('a');
    downloadAnchorNode.setAttribute("href", dataStr);
    downloadAnchorNode.setAttribute("download", "heuristic_maps.txt");
    document.body.appendChild(downloadAnchorNode); // required for firefox
    downloadAnchorNode.click();
    downloadAnchorNode.remove();
    console.log("Heuristic maps (text and images) have been computed and downloaded.");
}
