export interface AgentToolSettings { agentEditTools: boolean; agentSaveTool: boolean }
export const DEFAULT_AGENT_TOOL_SETTINGS: AgentToolSettings = { agentEditTools: false, agentSaveTool: false };
export function setAgentEditing(settings: AgentToolSettings, enabled: boolean): void {
  settings.agentEditTools = enabled;
  if (!enabled) settings.agentSaveTool = false;
}
