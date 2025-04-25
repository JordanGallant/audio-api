const express = require('express');
const multer = require('multer');
const path = require('path');
const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs');
const cors = require('cors');
const dotenv = require('dotenv');
const axios = require('axios');
const youtubedl = require('youtube-dl-exec');

dotenv.config();
api = process.env.YOUTUBE_API

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json()); //handles requests json bodies
app.use(express.text());
// Basic logging
app.use((req, res, next) => {
    console.log(`${req.method} ${req.url}`);
    next();
});

// search endpoint to YouTube -> now returns videoId to client
app.post('/search', async (req, res) => {
    const query = req.body;
    const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&q=${query}&key=${api}&maxResults=10`;
    try {
        console.log("Sending request to YouTube API");
        const response = await axios.get(url);

        // checks video is not a music video -> unwanted/dead audio
        let videoId, title;
        for (const item of response.data.items) {
            if (item.id.videoId && item.snippet.title) {
                const currentTitle = item.snippet.title;
                if (!currentTitle.toLowerCase().includes('official') && !currentTitle.toLowerCase().includes('show') && !currentTitle.toLowerCase().includes('stage')) {
                    videoId = item.id.videoId;
                    console.log("vidoe", videoId)
                    break;
                }
            }
        }

        // return the video Id and title to the client
        res.status(200).json({
            videoId: videoId
        });
    } catch (error) {
        console.error('❌ YouTube API error:', error.message);
        res.status(500).json({ error: 'Failed to fetch YouTube results' });
    }
});


const upload = multer({ dest: 'uploads/' });
const progressClients = new Map(); // key: id, value: response

// SSE endpoint to stream progress updates
app.get('/progress', (req, res) => {
    const id = req.query.id;
    if (!id) return res.status(400).send("Missing id");

    res.set({
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
    });
    res.flushHeaders();

    progressClients.set(id, res);

    req.on('close', () => {
        progressClients.delete(id);
    });
});

const downloadDir = path.join(__dirname, 'downloads');
if (!fs.existsSync(downloadDir)) {
  fs.mkdirSync(downloadDir);
}

//receives video id -> download the audio from youtube 
app.post('/download', async (req, res) => {
    const { id } = req.body;
    if (!id) {
      return res.status(400).json({ error: 'Video ID is required' });
    }
  
    const url = `https://www.youtube.com/watch?v=${id}`;
    const outputPath = path.join(downloadDir, `${id}.mp3`);
  
    try {
      // Download audio from YouTube video
      await youtubedl(url, {
        extractAudio: true,
        audioFormat: 'mp3',
        output: outputPath,
        noCheckCertificates: true,
        noWarnings: true,
        preferFreeFormats: true,
        youtubeSkipDashManifest: true,
      });
  
      // Set headers for streaming the file
      res.setHeader('Content-Disposition', `attachment; filename="${id}.mp3"`);
      res.setHeader('Content-Type', 'audio/mpeg');
  
      // Create a read stream and pipe it to the response
      const fileStream = fs.createReadStream(outputPath);
      fileStream.pipe(res);
  
      // Delete the file after sending it
      fileStream.on('end', () => {
        fs.unlink(outputPath, (err) => {
          if (err) console.error('Error deleting file:', err);
        });
      });
    } catch (error) {
      console.error('Download error:', error);
      res.status(500).json({ error: 'Failed to download audio' });
    }
  });
  
// audio conversion endpoint - recieves audio data
app.post('/convert-audio', upload.single('audio'), (req, res) => {
    const id = req.query.id;
    const audioFile = req.file;

    if (!audioFile) return res.status(400).send('No file uploaded');

    console.log('Received audio file:', audioFile);

    const inputPath = req.file.path;
    const outputPath = `uploads/${Date.now()}_320kbps.mp3`;

    ffmpeg(inputPath)
        .audioBitrate(320) //converts to 320kbps
        .on('start', (commandLine) => {
            console.log('[FFMPEG START]', commandLine);
        })
        .on('progress', (progress) => {
            const client = progressClients.get(id);
            if (client) {
                const message = JSON.stringify({
                    percent: progress.percent?.toFixed(2),
                });
                client.write(`data: ${message}\n\n`);
            }
        })
        .on('stderr', (stderrLine) => {
            console.log('[FFMPEG STDERR]', stderrLine);
        })
        .on('end', () => {
            console.log('[FFMPEG END] Conversion finished.');

            // Close SSE stream and notify client
            const client = progressClients.get(id);
            if (client) {
                client.write(`data: ${JSON.stringify({ done: true })}\n\n`);
                client.end();
                progressClients.delete(id);
            }

            res.download(outputPath, (err) => {
                if (err) {
                    console.error('Error during file download:', err);
                    res.status(500).send('Error during file download');
                }

                fs.unlinkSync(inputPath);
                fs.unlinkSync(outputPath);
            });
        })
        .on('error', (err) => {
            console.error('[FFMPEG ERROR]', err.message);
            res.status(500).send('Error during conversion');

            const client = progressClients.get(id);
            if (client) {
                client.write(`data: ${JSON.stringify({ error: true })}\n\n`);
                client.end();
                progressClients.delete(id);
            }

            fs.existsSync(inputPath) && fs.unlinkSync(inputPath);
            fs.existsSync(outputPath) && fs.unlinkSync(outputPath);
        })
        .save(outputPath);
});




// starts server
app.listen(3000, () => {
    console.log('Server is running on port 3000');
});
