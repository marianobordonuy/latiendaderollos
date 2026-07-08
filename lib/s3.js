import { S3Client } from "@aws-sdk/client-s3"
import { Upload } from "@aws-sdk/lib-storage"

export const s3 = new S3Client({
    region: "auto",
    endpoint: process.env.R2_ENDPOINT,
    credentials: {
        accessKeyId:     process.env.R2_KEY,
        secretAccessKey: process.env.R2_SECRET
    },
    forcePathStyle: true
})

export const BUCKETS = {
    scans:   process.env.R2_BUCKET,
    prints:  process.env.R2_BUCKET_PRINTS,
    backups: process.env.R2_BUCKET_BACKUPS
}

const PUBLIC_URLS = {
    scans:  process.env.R2_PUBLIC_URL,
    prints: process.env.R2_PUBLIC_URL_PRINTS
}

export async function uploadToR2({ bucket, key, body, contentType = "application/octet-stream" }) {
    const task = new Upload({
        client: s3,
        params: {
            Bucket:      bucket,
            Key:         key,
            Body:        body,
            ContentType: contentType
        }
    })
    await task.done()

    // Devolver la URL pública si corresponde
    const bucketName = Object.keys(BUCKETS).find(k => BUCKETS[k] === bucket)
    const publicUrl  = PUBLIC_URLS[bucketName]
    return publicUrl ? `${publicUrl}/${key}` : null
}