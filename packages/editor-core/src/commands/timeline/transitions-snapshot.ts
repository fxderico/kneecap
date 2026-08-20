import { Command, type CommandResult } from "@/commands/base-command";
import type { TSceneTransition } from "@/timeline";
import { EditorCore } from "@/core";

/**
 * Undoable swap of the active scene's main-track transitions — same shape
 * as TracksSnapshotCommand: the caller computes before/after, this command
 * owns apply + undo. Used by the timeline's transition sheet (set/remove/
 * apply-to-all all reduce to one list swap).
 */
export class TransitionsSnapshotCommand extends Command {
	constructor({
		before,
		after,
	}: {
		before: TSceneTransition[];
		after: TSceneTransition[];
	}) {
		super();
		this.before = before;
		this.after = after;
	}

	private before: TSceneTransition[];
	private after: TSceneTransition[];

	execute(): CommandResult | undefined {
		EditorCore.getInstance().scenes.updateSceneTransitions({
			transitions: this.after,
		});
		return undefined;
	}

	undo(): void {
		EditorCore.getInstance().scenes.updateSceneTransitions({
			transitions: this.before,
		});
	}
}
