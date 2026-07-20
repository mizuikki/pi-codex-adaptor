import {
	type AssistantMessage,
	type AssistantMessageEventStream,
	createAssistantMessageEventStream,
	type Model,
} from "@earendil-works/pi-ai";

import { CapabilityError } from "../../domain/capability.ts";
import { snapshotSimpleStreamOptions } from "./codex-provider-request-guard.ts";
import type { StreamSimpleDispatcher } from "./provider-dispatcher.ts";

const PROCESS_ROUTER_KEY = Symbol.for("pi-codex-adaptor.provider-session-router.v1");
const ROUTER_KIND = "pi-codex-adaptor-provider-session-router";
const ROUTER_VERSION = 1;

const ROUTE_UNAVAILABLE = "Codex provider route is unavailable for the current Pi session";
const ROUTE_AMBIGUOUS = "Codex provider route is ambiguous for the current Pi session";

export interface ProviderSessionDispatchers {
	readonly codexResponses: StreamSimpleDispatcher;
	readonly openAiResponses: StreamSimpleDispatcher;
}

export interface ProviderSessionLease {
	bind(sessionId: string): void;
	release(): void;
}

export interface ProcessProviderSessionRouter {
	readonly codexResponses: StreamSimpleDispatcher;
	readonly openAiResponses: StreamSimpleDispatcher;
	createLease(dispatchers: ProviderSessionDispatchers): ProviderSessionLease;
}

interface ProcessRouterSlotV1 {
	readonly kind: typeof ROUTER_KIND;
	readonly version: typeof ROUTER_VERSION;
	readonly router: ProcessProviderSessionRouter;
}

interface SessionDispatchBinding {
	readonly token: object;
	readonly dispatchers: ProviderSessionDispatchers;
	sessionId: string | undefined;
	released: boolean;
}

interface WeakBindingReference {
	deref(): SessionDispatchBinding | undefined;
}

interface FinalizationRegistration {
	readonly sessionId: string;
	readonly token: object;
}

interface RouterConstructionOptions {
	readonly createWeakReference?: (binding: SessionDispatchBinding) => WeakBindingReference;
}

interface BindingResolution {
	readonly kind: "found" | "unavailable" | "ambiguous";
	readonly binding?: SessionDispatchBinding;
}

/** Construct an isolated router. Production composition should use the process router below. */
export function createProviderSessionRouter(
	options: RouterConstructionOptions = {},
): ProcessProviderSessionRouter {
	const buckets = new Map<string, Map<object, WeakBindingReference>>();
	const createWeakReference = options.createWeakReference ?? ((binding) => new WeakRef(binding));
	const finalizer = new FinalizationRegistry<FinalizationRegistration>(({ sessionId, token }) => {
		removeToken(buckets, sessionId, token);
	});

	const dispatch =
		(field: keyof ProviderSessionDispatchers): StreamSimpleDispatcher =>
		(model, context, streamOptions) => {
			const optionsSnapshot = snapshotSimpleStreamOptions(streamOptions);
			const sessionId = optionsSnapshot?.sessionId;
			if (typeof sessionId !== "string" || sessionId.trim().length === 0) {
				return createRouteErrorStream(
					model,
					new CapabilityError("provider_session_unavailable", ROUTE_UNAVAILABLE),
				);
			}
			const resolved = resolveBinding(buckets, sessionId);
			if (resolved.kind !== "found" || resolved.binding === undefined) {
				return createRouteErrorStream(
					model,
					new CapabilityError(
						"provider_session_unavailable",
						resolved.kind === "ambiguous" ? ROUTE_AMBIGUOUS : ROUTE_UNAVAILABLE,
					),
				);
			}
			return resolved.binding.dispatchers[field](model, context, optionsSnapshot);
		};

	const router: ProcessProviderSessionRouter = {
		codexResponses: dispatch("codexResponses"),
		openAiResponses: dispatch("openAiResponses"),
		createLease(dispatchers) {
			const binding: SessionDispatchBinding = {
				token: {},
				dispatchers,
				sessionId: undefined,
				released: false,
			};
			return {
				bind(sessionId) {
					if (typeof sessionId !== "string" || sessionId.trim().length === 0) {
						throw new Error("Codex provider session binding requires a non-empty session id");
					}
					if (binding.released) {
						throw new Error("Released Codex provider session binding cannot be rebound");
					}
					if (binding.sessionId !== undefined) {
						finalizer.unregister(binding.token);
						removeToken(buckets, binding.sessionId, binding.token);
					}
					binding.sessionId = sessionId;
					const bucket = buckets.get(sessionId) ?? new Map<object, WeakBindingReference>();
					bucket.set(binding.token, createWeakReference(binding));
					buckets.set(sessionId, bucket);
					finalizer.register(binding, { sessionId, token: binding.token }, binding.token);
				},
				release() {
					if (binding.released) return;
					binding.released = true;
					finalizer.unregister(binding.token);
					if (binding.sessionId !== undefined) {
						removeToken(buckets, binding.sessionId, binding.token);
						binding.sessionId = undefined;
					}
				},
			};
		},
	};
	return router;
}

/** Return one process-stable router across independently evaluated extension module graphs. */
export function getProcessProviderSessionRouter(): ProcessProviderSessionRouter {
	const current = Reflect.get(globalThis, PROCESS_ROUTER_KEY);
	if (current !== undefined) {
		if (!isCompatibleSlot(current)) {
			throw new Error("Codex provider session router global slot is incompatible");
		}
		return current.router;
	}
	const slot: ProcessRouterSlotV1 = {
		kind: ROUTER_KIND,
		version: ROUTER_VERSION,
		router: createProviderSessionRouter(),
	};
	if (!Reflect.set(globalThis, PROCESS_ROUTER_KEY, slot)) {
		throw new Error("Codex provider session router global slot is incompatible");
	}
	const installed = Reflect.get(globalThis, PROCESS_ROUTER_KEY);
	if (!isCompatibleSlot(installed)) {
		throw new Error("Codex provider session router global slot is incompatible");
	}
	return installed.router;
}

function resolveBinding(
	buckets: Map<string, Map<object, WeakBindingReference>>,
	sessionId: string,
): BindingResolution {
	const bucket = buckets.get(sessionId);
	if (bucket === undefined) return { kind: "unavailable" };
	const live: SessionDispatchBinding[] = [];
	for (const [token, reference] of bucket) {
		const binding = reference.deref();
		if (binding === undefined || binding.released || binding.sessionId !== sessionId) {
			bucket.delete(token);
			continue;
		}
		live.push(binding);
	}
	if (bucket.size === 0) buckets.delete(sessionId);
	if (live.length === 0) return { kind: "unavailable" };
	if (live.length > 1) return { kind: "ambiguous" };
	const binding = live[0];
	return binding === undefined ? { kind: "unavailable" } : { kind: "found", binding };
}

function removeToken(
	buckets: Map<string, Map<object, WeakBindingReference>>,
	sessionId: string,
	token: object,
): void {
	const bucket = buckets.get(sessionId);
	if (bucket === undefined) return;
	bucket.delete(token);
	if (bucket.size === 0) buckets.delete(sessionId);
}

function isCompatibleSlot(value: unknown): value is ProcessRouterSlotV1 {
	if (typeof value !== "object" || value === null) return false;
	const slot = value as Partial<ProcessRouterSlotV1>;
	if (slot.kind !== ROUTER_KIND || slot.version !== ROUTER_VERSION) return false;
	const router = slot.router;
	return (
		typeof router === "object" &&
		router !== null &&
		typeof router.codexResponses === "function" &&
		typeof router.openAiResponses === "function" &&
		typeof router.createLease === "function"
	);
}

function createRouteErrorStream(
	model: Model<string>,
	error: CapabilityError,
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	const output = createEmptyAssistantMessage(model);
	stream.push({ type: "start", partial: output });
	output.stopReason = "error";
	output.errorMessage = error.reason;
	stream.push({ type: "error", reason: "error", error: output });
	stream.end();
	return stream;
}

function createEmptyAssistantMessage(model: Model<string>): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			reasoning: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}
