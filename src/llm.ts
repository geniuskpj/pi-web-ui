// LLM message conversion — vendored from pi-agent-core + our custom message
// type (plan.md P0: moved out of custom-messages.ts so nothing here depends on
// pi-web-ui).
//
// defaultConvertToLlm is NOT exported by @earendil-works/pi-agent-core (it is
// module-private in dist/agent.js) — vendored verbatim from 0.75.3: a 3-line role
// filter. Re-verify on upgrade: grep "function defaultConvertToLlm" in
// node_modules/@earendil-works/pi-agent-core/dist/agent.js
// Loop invariant (plan.md §2.8 #3): toolResult messages (incl. isError:true)
// MUST survive the filter, else the model retries blind after tool errors.
import type { Message } from "@earendil-works/pi-ai";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

export interface SystemNotificationMessage {
	role: "system-notification";
	message: string;
	variant: "default" | "destructive";
	timestamp: string;
}

declare module "@earendil-works/pi-agent-core" {
	interface CustomAgentMessages {
		"system-notification": SystemNotificationMessage;
	}
}

/** Vendored from pi-agent-core (not exported there): keep only LLM-visible roles. */
export function defaultConvertToLlm(messages: AgentMessage[]): Message[] {
	return messages.filter(
		(message) => message.role === "user" || message.role === "assistant" || message.role === "toolResult",
	) as Message[];
}

export function createSystemNotification(
	message: string,
	variant: "default" | "destructive" = "default",
): SystemNotificationMessage {
	return {
		role: "system-notification",
		message,
		variant,
		timestamp: new Date().toISOString(),
	};
}

/** system-notification → user message wrapped in <system> tags, then role filter. */
export function customConvertToLlm(messages: AgentMessage[]): Message[] {
	const processed = messages.map((m): AgentMessage => {
		if (m.role === "system-notification") {
			const notification = m as SystemNotificationMessage;
			return {
				role: "user",
				content: `<system>${notification.message}</system>`,
				timestamp: Date.now(),
			};
		}
		return m;
	});
	return defaultConvertToLlm(processed);
}
