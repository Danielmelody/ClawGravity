function normalizeStatusValue(status: unknown): string {
    return typeof status === 'string'
        ? status.trim().toLowerCase()
        : '';
}

function getConcreteToolCall(step: any): any | null {
    return step?.metadata?.toolCall
        || step?.toolCall
        || null;
}

export function getToolCallName(toolCall: any): string {
    return String(
        toolCall?.name
        || toolCall?.toolName
        || toolCall?.function?.name
        || '',
    ).toLowerCase();
}

export function getToolCallId(toolCall: any): string {
    return String(toolCall?.id || '').trim();
}

export function isToolCallCompleted(toolCall: any): boolean {
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

export function isStepTerminal(step: any): boolean {
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

export function isStepActive(step: any): boolean {
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

export function findConcreteToolStep(
    steps: any[],
    plannerStepIndex: number,
    toolCallId: string,
): any | null {
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

export function isToolCallPendingInTrajectory(
    steps: any[],
    plannerStepIndex: number,
    toolCall: any,
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
    steps: any[],
    plannerStepIndex: number,
): any[] {
    const step = steps[plannerStepIndex];
    const toolCalls = step?.plannerResponse?.toolCalls;
    if (!Array.isArray(toolCalls)) return [];

    return toolCalls.filter((toolCall: any) =>
        isToolCallPendingInTrajectory(steps, plannerStepIndex, toolCall),
    );
}
