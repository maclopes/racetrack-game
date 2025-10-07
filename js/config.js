export const WAYPOINT_SEQUENCE = ['1', '2', '3'];
export const MAX_VELOCITY_MANHATTAN_DISTANCE = 6;
export const BFS_MAX_STEPS = 100000; // Max iterations for pathfinding search
export const ACCELERATIONS = [
    { ax: -1, ay: -1 }, { ax: 0, ay: -1 }, { ax: 1, ay: -1 },
    { ax: -1, ay: 0 }, { ax: 0, ay: 0 }, { ax: 1, ay: 0 },
    { ax: -1, ay: 1 }, { ax: 0, ay: 1 }, { ax: 1, ay: 1 }
];

// Checkbox preferences (persisted)
export const PREF_SHOW_AI_PATH = 'pref_show_ai_path_v1';
export const PREF_SHOW_PLAYER_PATH = 'pref_show_player_path_v1';
