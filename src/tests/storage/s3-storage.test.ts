import { Readable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The S3 backend (F17) against a fake client. Real buckets are checked by a person (FINAL_REPORT §7).
const fake = vi.hoisted(() => ({
    sent: [] as Array<{ name: string; input: Record<string, unknown> }>,
    respond: vi.fn(async (_command: unknown): Promise<unknown> => ({})),
    NotFound: undefined as unknown as new (args: {
        message: string;
        $metadata: Record<string, unknown>;
    }) => Error,
}));

vi.mock("@aws-sdk/client-s3", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@aws-sdk/client-s3")>();
    fake.NotFound = actual.NotFound as unknown as typeof fake.NotFound;
    class S3Client {
        async send(command: {
            constructor: { name: string };
            input: Record<string, unknown>;
        }) {
            fake.sent.push({
                name: command.constructor.name,
                input: command.input,
            });
            return fake.respond(command);
        }
    }
    return { ...actual, S3Client };
});

import { S3Storage } from "@/lib/storage/s3-storage";

const config = {
    region: "auto",
    accessKeyId: "test-access-key",
    secretAccessKey: "test-secret",
    bucket: "oah-test-bucket",
    endpoint: "http://minio.invalid:9000",
} as const;

describe("S3Storage", () => {
    beforeEach(() => {
        fake.sent = [];
        fake.respond.mockReset();
        fake.respond.mockImplementation(async () => ({}));
    });

    it("uploads with the bucket, key and content type", async () => {
        const storage = new S3Storage(config);
        await storage.uploadFile(
            "user-1/clip.m4a",
            Buffer.from("abc"),
            "audio/mp4",
        );

        expect(fake.sent).toHaveLength(1);
        expect(fake.sent[0].name).toBe("PutObjectCommand");
        expect(fake.sent[0].input).toMatchObject({
            Bucket: "oah-test-bucket",
            Key: "user-1/clip.m4a",
            ContentType: "audio/mp4",
        });
    });

    it("downloads the object body as one buffer", async () => {
        fake.respond.mockImplementation(async () => ({
            Body: Readable.from([Buffer.from("he"), Buffer.from("llo")]),
        }));
        const storage = new S3Storage(config);

        const data = await storage.downloadFile("user-1/clip.m4a");
        expect(data.toString()).toBe("hello");
        expect(fake.sent[0]).toMatchObject({
            name: "GetObjectCommand",
            input: { Bucket: "oah-test-bucket", Key: "user-1/clip.m4a" },
        });
    });

    it("reports a missing object as not existing, and an existing one as present", async () => {
        const storage = new S3Storage(config);

        fake.respond.mockImplementation(async () => ({}));
        await expect(storage.exists("present.m4a")).resolves.toBe(true);

        fake.respond.mockImplementation(async () => {
            throw new fake.NotFound({ message: "missing", $metadata: {} });
        });
        await expect(storage.exists("absent.m4a")).resolves.toBe(false);
    });

    it("deletes the object", async () => {
        const storage = new S3Storage(config);
        await storage.deleteFile("user-1/clip.m4a");

        expect(fake.sent[0]).toMatchObject({
            name: "DeleteObjectCommand",
            input: { Bucket: "oah-test-bucket", Key: "user-1/clip.m4a" },
        });
    });
});
