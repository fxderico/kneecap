import { describe, expect, it } from "bun:test";
import { pipSpawnParams } from "./pip-spawn";

const CANVAS = { canvasWidth: 1080, canvasHeight: 1920 };
const NUDGE = 1080 * 0.06;

describe("pipSpawnParams (duplicate lands as visible PiP)", () => {
	it("halves video scale and nudges off-center", () => {
		const next = pipSpawnParams({
			params: {},
			elementType: "video",
			...CANVAS,
		});
		expect(next["transform.scaleX"]).toBe(0.5);
		expect(next["transform.scaleY"]).toBe(0.5);
		expect(next["transform.positionX"]).toBe(NUDGE);
		expect(next["transform.positionY"]).toBe(-NUDGE);
	});

	it("compounds with an existing transform and preserves flip sign", () => {
		const next = pipSpawnParams({
			params: {
				"transform.scaleX": -0.8,
				"transform.scaleY": 0.8,
				"transform.positionX": 100,
				"transform.positionY": 50,
			},
			elementType: "image",
			...CANVAS,
		});
		expect(next["transform.scaleX"]).toBe(-0.4);
		expect(next["transform.scaleY"]).toBe(0.4);
		expect(next["transform.positionX"]).toBe(100 + NUDGE);
		expect(next["transform.positionY"]).toBe(50 - NUDGE);
	});

	it("only nudges non-media visuals (text keeps its size)", () => {
		const next = pipSpawnParams({
			params: { "transform.scaleX": 1.4 },
			elementType: "text",
			...CANVAS,
		});
		expect(next["transform.scaleX"]).toBe(1.4);
		expect(next["transform.scaleY"]).toBeUndefined();
		expect(next["transform.positionX"]).toBe(NUDGE);
	});

	it("does not mutate the input params", () => {
		const params = { "transform.scaleX": 1 };
		pipSpawnParams({ params, elementType: "video", ...CANVAS });
		expect(params["transform.scaleX"]).toBe(1);
	});
});
