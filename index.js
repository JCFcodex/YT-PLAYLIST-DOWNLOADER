const express = require('express');
const path = require('path');
const { spawn } = require('child_process');
const fs = require('fs').promises;
const bodyParser = require('body-parser');
const cors = require('cors');
const WebSocket = require('ws');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(
  cors({
    origin: '*',
    methods: ['GET', 'POST'],
  })
);
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'build')));

const wss = new WebSocket.Server({ noServer: true });

let clients = [];

wss.on('connection', (ws) => {
  clients.push(ws);
  console.log('Client connected for WebSocket.');

  ws.on('close', () => {
    clients = clients.filter((client) => client !== ws);
    console.log('Client disconnected from WebSocket.');
  });
});

const cleanDownloadFolder = async (folderPath) => {
  try {
    await fs.mkdir(folderPath, { recursive: true });
    const files = await fs.readdir(folderPath);
    console.log(`Files in folder before cleaning: ${files}`);
    for (const file of files) {
      await fs.unlink(path.join(folderPath, file));
    }
    console.log('Download folder cleaned successfully.');
  } catch (error) {
    console.error('Error cleaning download folder:', error);
    throw error;
  }
};

const sendProgressToClients = (data) => {
  clients.forEach((client) => {
    client.send(JSON.stringify(data));
    console.log('SUCCESSFULLY SENT TO CLIENT');
  });
};

app.post('/api/download', async (req, res) => {
  const { playlistUrl } = req.body;
  const ytDlpPath = path.join(__dirname, 'yt-dlp');
  const downloadFolder = path.join(__dirname, 'downloads');

  try {
    await cleanDownloadFolder(downloadFolder);
    await fs.mkdir(downloadFolder, { recursive: true });

    const ytDlp = spawn(ytDlpPath, [
      '-o',
      `${downloadFolder}/%(title)s.%(ext)s`,
      '-f',
      'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4][height<=1080]/best',
      '--merge-output-format',
      'mp4',
      '--restrict-filenames',
      playlistUrl,
    ]);

    ytDlp.stdout.on('data', (data) => {
      const match = data
        .toString()
        .match(/\[download\] Downloading item (\d+) of (\d+)/);
      if (match) {
        const currentItem = parseInt(match[1]);
        const totalItems = parseInt(match[2]);
        console.log(`${currentItem} out of ${totalItems}`);
        sendProgressToClients({ currentItem, totalItems });
      }
    });

    ytDlp.stderr.on('data', (data) => {
      console.error(`yt-dlp stderr: ${data}`);
    });

    ytDlp.on('close', (code) => {
      console.log(`yt-dlp process exited with code ${code}`);
      if (code === 0) {
        const zipFile = `${downloadFolder}/playlist.zip`;
        const zipCommand = `powershell Compress-Archive -Path ${downloadFolder}/* -DestinationPath ${zipFile}`;

        const zipProcess = spawn(zipCommand, { shell: true });

        zipProcess.stdout.on('data', (data) => {
          console.log(`zip stdout: ${data}`);
        });

        zipProcess.stderr.on('data', (data) => {
          console.error(`zip stderr: ${data}`);
        });

        zipProcess.on('close', (zipCode) => {
          console.log(`zip process exited with code ${zipCode}`);
          if (zipCode === 0) {
            const zipPath = path.join(__dirname, 'downloads', 'playlist.zip');
            res.download(zipPath, (err) => {
              if (err) {
                console.error('Error downloading zip file:', err);
                res.status(500).send('Error downloading zip file');
              } else {
                cleanDownloadFolder(downloadFolder)
                  .then(() => {
                    console.log('Download folder cleaned up.');
                  })
                  .catch((cleanErr) => {
                    console.error('Error cleaning download folder:', cleanErr);
                  });
              }
            });
          } else {
            res.status(500).send('Error creating zip file');
          }
        });
      } else {
        res.status(500).send('Error downloading playlist');
      }
    });
  } catch (error) {
    console.error('Error starting download:', error);
    res.status(500).send('Error starting download');
  }
});

const server = app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});

server.on('upgrade', (request, socket, head) => {
  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit('connection', ws, request);
  });
});

//TODO: Fix errors when zipping large files.
