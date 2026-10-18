import { expect, test } from "@playwright/test";
import { newUserContext, uploadRecording } from "../helpers/api";

test("harness: upload helper returns a readable recording id", async () => {
    const api = await newUserContext("harness");
    const id = await uploadRecording(api);
    const res = await api.get(`/api/recordings/${id}`);
    expect(res.status()).toBe(200);
    await api.dispose();
});
