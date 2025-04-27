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
        let videoId;
        for (const item of response.data.items) {
            if (item.id.videoId && item.snippet.title) {
                const currentTitle = item.snippet.title;
                if (!currentTitle.toLowerCase().includes('official') && !currentTitle.toLowerCase().includes('show') && !currentTitle.toLowerCase().includes('stage')&& !currentTitle.toLowerCase().includes('remix')) {
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
    const { id: videoId } = req.body;
    const id = req.query.id; // Get the tracking ID from the query parameter 
    const url = `https://www.youtube.com/watch?v=${videoId}`; //sets youtube url
    const outputPath = path.join(__dirname, 'downloads', `${videoId}.mp3`); //temp folder for downloading from youtube
    const convertedPath = path.join(__dirname, 'downloads', `${videoId}_320kbps.mp3`);
    const cookiesPath = path.join(__dirname, 'cookies.txt'); //finds spoofed auth cookies
    
    try {
      // check if cookies file exists
      if (!fs.existsSync(cookiesPath)) {
        console.log('Creating cookies file from browser...');
        try {
            //loads cookies to bypass auth
          await youtubedl('https://www.youtube.com/', {
            dumpSingleJson: true,
            skipDownload: true,
            cookiesFromBrowser: 'chrome',
            cookies: cookiesPath
          });
        } catch (cookieError) {
          console.log('Cookie extraction warning:', cookieError.message);
        }
      }
      
      // Send initial progress update
      const client = progressClients.get(id);
      if (client) {
          client.write(`data: ${JSON.stringify({ percent: "0.00" })}\n\n`);
      }
      
      // Download audio from YouTube with progress tracking
      await new Promise((resolve, reject) => {
        const ytdlOptions = {
          extractAudio: true,
          audioFormat: 'mp3',
          output: outputPath,
          noCheckCertificates: true,
          noWarnings: true,
          preferFreeFormats: true,
          youtubeSkipDashManifest: true,
          cookies: cookiesPath,
          geoBypass: true,
          userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
          addHeader: [
            'Accept:text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
            'Accept-Language:en-US,en;q=0.5',
            'DNT:1',
            'Connection:keep-alive'
          ],
          retries: 3,
          socketTimeout: 30,
          progressTemplate: 'download:%(progress.downloaded_bytes)s/%(progress.total_bytes)s'
        };

        const process = youtubedl.exec(url, ytdlOptions);
        
        let lastPercent = 0;
        process.stdout.on('data', (data) => {
          const output = data.toString();
          const match = output.match(/download:(\d+)\/(\d+)/);
          
          if (match) {
            const downloaded = parseInt(match[1]);
            const total = parseInt(match[2]);
            
            if (total > 0) {
              // Calculate percentage and scale to 0-50% range
              const downloadPercent = Math.min(50 * (downloaded / total), 50).toFixed(2);
              
              // Only send updates if percent changed significantly (avoid flooding)
              if (Math.abs(parseFloat(downloadPercent) - lastPercent) > 1) {
                lastPercent = parseFloat(downloadPercent);
                const client = progressClients.get(id);
                if (client) {
                  client.write(`data: ${JSON.stringify({ percent: downloadPercent })}\n\n`);
                }
              }
            }
          }
        });

        process.stderr.on('data', (data) => {
          console.error(`stderr: ${data}`);
        });

        process.on('error', (error) => {
          console.error('Youtube-dl process error:', error);
          reject(error);
        });

        process.on('close', (code) => {
          if (code === 0) {
            console.log(`[YOUTUBE-DL END] Successfully downloaded video ${videoId} to ${outputPath}`);
            resolve();
          } else {
            reject(new Error(`Youtube-dl process exited with code ${code}`));
          }
        });
      });

      // send progress update after download
      if (client) {
          client.write(`data: ${JSON.stringify({ percent: "50.00" })}\n\n`); //50 when done
      }

      // convert bitrate to 320kbps using fluent-ffmpeg
      await new Promise((resolve, reject) => {
        ffmpeg(outputPath)
          .audioBitrate(320)
          .format('mp3')
          .on('progress', (progress) => {
              // calculate total progress (50% for download + 50% for conversion)
              const totalProgress = 50 + (progress.percent || 0) * 0.5;
              
              // send progress update
              const client = progressClients.get(id);
              if (client) {
                  client.write(`data: ${JSON.stringify({
                      percent: totalProgress.toFixed(2)
                  })}\n\n`);
              }
          })
          .on('error', (err) => {
            console.error('FFmpeg error:', err);
            reject(err);
          })
          //server logging when coversion done
          .on('end', () => {
            console.log('Bitrate conversion completed');
            
            // Send final progress update
            const client = progressClients.get(id);
            if (client) {
                client.write(`data: ${JSON.stringify({ percent: "100.00", done: true })}\n\n`);
            }
            
            resolve();
          })
          .save(convertedPath);
      });

      // Send download link
      res.json({
        success: true,
        message: 'Download completed successfully',
        file: `/download-file/${videoId}_320kbps.mp3`
      });

    } catch (error) {
      console.error('Download error:', error);
      
      // Notify client of error
      const client = progressClients.get(id);
      if (client) {
        client.write(`data: ${JSON.stringify({ error: error.message })}\n\n`);
      }
      
      res.status(500).json({
        success: false,
        message: 'Download failed',
        error: error.message
      });
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

            // close SSE stream and notify client
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
