// ADAPTED FROM
// https://jross.me/free-personal-image-hosting-with-backblaze-b2-and-cloudflare-workers/

declare var B2_AUTH_ENDPOINT: string;
declare var B2_BUCKET: string;
declare var B2_BUCKET_ID: string;
declare var B2_DOMAIN: string;
declare var B2_KEY: string;
declare var B2_KEY_ID: string;

// ADAPTED FROM
// https://jross.me/free-personal-image-hosting-with-backblaze-b2-and-cloudflare-workers/

const b2UrlPath = `/file/${B2_BUCKET}`;
addEventListener("fetch", (event) => event.respondWith(handleReq(event)));

// backblaze returns some additional headers that are useful for debugging, but unnecessary in production. We can remove these to save some size
const removeHeaders = [
	"x-bz-content-sha1",
	"x-bz-file-id",
	"x-bz-file-name",
	"x-bz-info-src_last_modified_millis",
	"X-Bz-Upload-Timestamp",
	"Expires",
];
const expiration = 31536000; // override browser cache for images - 1 year

// define a function we can re-use to fix headers
function fixHeaders(_url: URL, status: number, headers: Headers) {
	const newHdrs = new Headers(headers);

	// add basic cors headers
	newHdrs.set("Access-Control-Allow-Origin", "*");

	// override browser cache for files when 200
	if (status === 200) newHdrs.set("Cache-Control", "public, max-age=" + expiration);
	// only cache other things for 5 minutes
	else newHdrs.set("Cache-Control", "public, max-age=300");

	// set ETag for efficient caching where possible
	const ETag = newHdrs.get("x-bz-content-sha1") || newHdrs.get("x-bz-info-src_last_modified_millis") || newHdrs.get("x-bz-file-id");
	if (ETag) newHdrs.set("ETag", ETag);

	// remove unnecessary headers
	removeHeaders.forEach((header) => newHdrs.delete(header));
	return newHdrs;
}

const millisToISO = (m: number) => new Date(m).toISOString().split("T")[0];

function formatBytes(b: number) {
	if (b >= 1_000_000) return (b / 1_000_000).toPrecision(3) + "MB";

	if (b >= 1_000) return (b / 1_000).toPrecision(3) + "kB";

	return b + "B";
}

// prepares the index page
async function getIndex() {
	// initial authorization
	const initResp = await fetch(B2_AUTH_ENDPOINT, {
		headers: {
			Authorization: "Basic " + btoa(`${B2_KEY_ID}:${B2_KEY}`),
		},
	}).then((r) => r.json() as any);

	const { apiUrl, authorizationToken } = initResp;

	// fetch all index files from ylsink bucket
	const targetUrl = new URL("/b2api/v2/b2_list_file_names", apiUrl).href;

	const indexResp = await fetch(targetUrl, {
		method: "POST",
		headers: { Authorization: authorizationToken },
		body: JSON.stringify({ bucketId: B2_BUCKET_ID }),
	}).then((r) => r.json() as any);

	const resp = `<!DOCTYPE html>
<html>
<head><title>sink files index</title></head>
<body>
<table>
<thead>
  <tr>
    <th>Name</th>
    <th>Type</th>
    <th>Size</th>
    <th>Date</th>
  </tr>
</thead>
<tbody>

${indexResp.files
	.map(
		(f: any) => `
  <tr>
    <td><a href="${encodeURIComponent(f.fileName)}">${f.fileName}</a></td>
    <td>${f.contentType}</td>
    <td>${formatBytes(f.contentLength)}</td>
    <td>${millisToISO(f.uploadTimestamp)}</td>
  </tr>
`
	)
	.join("")}

</tbody>
</table>
</body></html>`;

	return new Response(resp, {
		headers: {
			"Access-Control-Allow-Origin": "*",
			"Content-Type": "text/html",
		},
	});
}

function handleRange(req: Request, resp: Response) {
	if (!resp.body) return resp;
	const rangeHeader = req.headers.get("Range");
	if (!rangeHeader) return resp;
	const match = rangeHeader.match(/bytes=(\d*)-(\d*)$/);
	if (!match) return resp;
	const [, ns1, ns2] = match;
	if (!ns1 && !ns2) return resp;

	const [n1, n2] = [parseInt(ns1), parseInt(ns2)];

	//if (resp.bodyUsed) throw new Error("body should not be used in handleRange()");

	const reader = resp.body.getReader();
	let i = 0;

	const newBody = new ReadableStream({
		start(controller) {
			function push() {
				reader.read().then(({ done, value }) => {
					if (done) return controller.close();

					// handle skipping the start
					if (n1 && i < n1) {
						const toSkip = n1 - i;

						if (value.length > toSkip) {
							// we need to slice some of this!
							const afterSkip = value.slice(toSkip);
							value = afterSkip;
							i += toSkip;
						}
					}

					// handle chopping off the end
					if (n2 && i + value.length > n2) {
						const amt = n2 - i;
						i += amt;
						controller.enqueue(value.slice(0, amt));
						return controller.close();
					}

					i += value.length;
					controller.enqueue(value);

					// queue reading the next
					push();
				});
			}

			push();
		},
	});

	const origLen = parseInt(resp.headers.get("Content-Length")!);

	const len = (n2 ?? origLen) - (n1 ?? 0);

	// this is necessary to set the content-length
	// as per https://developers.cloudflare.com/workers/runtime-apis/response#set-the-content-length-header
	const flStream = new FixedLengthStream(len);

	// an exception appears here i think but srcew it
	newBody.pipeTo(flStream.writable);

	return new Response(flStream.readable, {
		status: 206,
		headers: {
			...Object.fromEntries(resp.headers.entries()),
			"Content-Range": `bytes ${n1 ?? 0}-${n2 ?? i}/${origLen /* ?? '*' */}`,
		},
	});
}

async function handleReq(event: FetchEvent) {
	const cache = caches.default; // Cloudflare edge caching

	const url = new URL(event.request.url);

	if (url.pathname === "/") return await getIndex();

	if (/* url.host === B2_DOMAIN &&  */ !url.pathname.startsWith(b2UrlPath)) {
		url.pathname = b2UrlPath + url.pathname;
		url.host = B2_DOMAIN;
	}

	let response = await cache.match(url); // try to find match for this request in the edge cache

	if (response) {
		// use cache found on Cloudflare edge. Set X-Worker-Cache header for helpful debug
		const newHdrs = fixHeaders(url, response.status, response.headers);
		newHdrs.set("X-Worker-Cache", "true");
		return handleRange(
			event.request,
			new Response(response.body, {
				status: response.status,
				statusText: response.statusText,
				headers: newHdrs,
			})
		);
	}

	response = await fetch(url);
	let newHdrs = fixHeaders(url, response.status, response.headers);
	response = new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers: newHdrs,
	});

	event.waitUntil(cache.put(url, response.clone()));

	return handleRange(
		event.request,
		new Response(response.body, {
			status: response.status,
			statusText: response.statusText,
			headers: newHdrs,
		})
	);
}
