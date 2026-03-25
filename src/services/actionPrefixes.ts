/**
 * Custom-ID prefix constants for button interactions.
 *
 * These prefixes are used as the leading segment of Discord/Telegram button
 * custom IDs to identify the action type. They are shared between:
 *   - cdpBridgeManager (builds & parses custom IDs)
 *   - notificationSender (builds custom IDs for notification buttons)
 */

// Approval action prefixes
export const APPROVE_ACTION_PREFIX = 'approve_action';
export const ALWAYS_ALLOW_ACTION_PREFIX = 'always_allow_action';
export const DENY_ACTION_PREFIX = 'deny_action';

// Planning action prefixes
export const PLANNING_OPEN_ACTION_PREFIX = 'planning_open_action';
export const PLANNING_PROCEED_ACTION_PREFIX = 'planning_proceed_action';

// Error popup action prefixes
export const ERROR_POPUP_CONTINUE_ACTION_PREFIX = 'error_popup_continue_action';

// Run command action prefixes
export const RUN_COMMAND_RUN_ACTION_PREFIX = 'run_command_run_action';
export const RUN_COMMAND_REJECT_ACTION_PREFIX = 'run_command_reject_action';
