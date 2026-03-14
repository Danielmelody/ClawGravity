/** Generic trajectory step with flexible properties */
interface TrajectoryStep {
    type?: string;
    status?: string;
    metadata?: {
        toolCall?: ToolCall;
    };
    toolCall?: ToolCall;
    plannerResponse?: {
        toolCalls?: ToolCall[];
    };
    [key: string]: unknown;
}

/** Tool call type */
interface ToolCall {
    id?: string;
    name?: string;
    toolName?: string;
    function?: {
        name?: string;
    };
    result?: unknown;
    output?: unknown;
    toolCallResult?: unknown;
    status?: string;
    toolCallStatus?: string;
}

function normalizeStatusValue(status: unknown): string {
    return typeof status === 'string'
        ? status.trim().toLowerCase()
        : '';
}

function getConcreteToolCall(step: TrajectoryStep): ToolCall | null {
    return step?.metadata?.toolCall
        || step?.toolCall
        || null;
}

export function getToolCallName(toolCall: ToolCall): string {
    return String(
        toolCall?.name
        || toolCall?.toolName
        || toolCall?.function?.name
        || '',
    ).toLowerCase();
}

function getToolCallId(toolCall: ToolCall): string {
    return String(toolCall?.id || '').trim();
}

function isToolCallCompleted(toolCall: ToolCall): boolean {
    const hasResult = toolCall?.result !== undefined
        || toolCall?.output !== undefined
        || toolCall?.toolCallResult !== undefined;
    if (hasResult) return true;

    const status = normalizeStatusValue(toolCall?.status || toolCall?.toolCallStatus);
    return [
        'completed',
        'done',
        'success',
        'error',
        'canceled',
        'cancelled',
        'rejected',
        'denied',
    ].some((value) => status.includes(value));
}

function isStepTerminal(step: TrajectoryStep): boolean {
    const status = normalizeStatusValue(step?.status);
    return [
        'done',
        'completed',
        'success',
        'error',
        'canceled',
        'cancelled',
        'rejected',
        'denied',
    ].some((value) => status.includes(value));
}

function isStepActive(step: TrajectoryStep): boolean {
    const status = normalizeStatusValue(step?.status);
    return [
        'pending',
        'running',
        'generating',
        'waiting',
        'approval',
        'confirm',
    ].some((value) => status.includes(value));
}

function findConcreteToolStep(
    steps: TrajectoryStep[],
    plannerStepIndex: number,
    toolCallId: string,
): TrajectoryStep | null {
    if (!toolCallId) return null;

    for (let i = plannerStepIndex + 1; i < steps.length; i++) {
        const concreteToolCall = getConcreteToolCall(steps[i]);
        if (!concreteToolCall) continue;
        if (getToolCallId(concreteToolCall) === toolCallId) {
            return steps[i];
        }
    }

    return null;
}

function isToolCallPendingInTrajectory(
    steps: TrajectoryStep[],
    plannerStepIndex: number,
    toolCall: ToolCall,
): boolean {
    if (isToolCallCompleted(toolCall)) {
        return false;
    }

    const concreteStep = findConcreteToolStep(steps, plannerStepIndex, getToolCallId(toolCall));
    if (concreteStep) {
        if (isStepTerminal(concreteStep)) {
            return false;
        }
        if (isStepActive(concreteStep)) {
            return true;
        }
    }

    return true;
}

export function getPendingToolCallsFromPlannerStep(
    steps: TrajectoryStep[],
    plannerStepIndex: number,
): ToolCall[] {
    const step = steps[plannerStepIndex];
    const toolCalls = step?.plannerResponse?.toolCalls;
    if (!Array.isArray(toolCalls)) return [];

    return toolCalls.filter((toolCall: ToolCall) =>
        isToolCallPendingInTrajectory(steps, plannerStepIndex, toolCall),
    );
}
