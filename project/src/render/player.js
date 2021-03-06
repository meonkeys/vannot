const { ceil } = Math;
const { select, scaleLinear } = require('d3');
const { getTemplate, instantiateTemplates, instantiateDivs, pct, pad, timecode, timecodePretty, queuer } = require('../util');


////////////////////////////////////////////////////////////////////////////////
// DRAWING ROUTINES
// Completely stateless routines that each update one part of the timeline/player UI.

////////////////////////////////////////
// TIMECODE

const drawTimecode = (player, target) => {
  const parts = timecode(player.frame, player.video.fps);
  target.select('.vannot-timecode-hh').text(pad(parts.hh));
  target.select('.vannot-timecode-mm').text(pad(parts.mm));
  target.select('.vannot-timecode-ss').text(pad(parts.ss));
  target.select('.vannot-timecode-fr').text(pad(parts.frame));
};

////////////////////////////////////////
// TICK SCALE

// given start, end in frames, fps, and width in pixels, creates an array of
// frame datapoints { frame: #, major: bool } to presented as ticks. 
const minorThreshold = 4; // smallest pixel distance between minor ticks.
const majorThreshold = 80; // smallest pixel distance between major ticks.
const tickScales = [
  1, 5, // framescale
  60, 2 * 60, 5 * 60, 15 * 60, 30 * 60, // second scales
  60 * 60, 2 * 60 * 60, 5 * 60 * 60, 15 * 60 * 60, 30 * 60 * 60 // minute scales
];
const generateTicks = ([ start, end ], fps, width) => {
  const duration = (end - start);

  // fallback to progressively larger scales. determine our first tick.
  const minorInterval = tickScales.find((scale) => (width / duration * scale) > minorThreshold);
  const first = ceil(start / minorInterval) * minorInterval;

  // determine major tick spacing.
  let majorInterval = minorInterval;
  while ((width / duration * majorInterval) < majorThreshold) majorInterval += minorInterval;
  if (majorInterval < fps) majorInterval = fps;

  // generate ticks.
  let frame = first;
  const result = [];
  while (frame < end) {
    result.push({ frame, major: ((frame % majorInterval) === 0) });
    frame += minorInterval;
  }
  return result;
};

const tickTemplate = getTemplate('tick');
const drawTicks = (player, target) => {
  const ticksData = generateTicks(player.range, player.video.fps, target.node().clientWidth);
  const ticks = instantiateTemplates(target.selectAll('.vannot-tick').data(ticksData), tickTemplate);

  ticks.style('left', (tick) => pct(player.scale(tick.frame)));
  ticks.classed('vannot-tick-major', (tick) => tick.major);
  ticks.filter((tick) => tick.major).select('span')
    .text((tick) => timecodePretty(tick.frame, player.video.fps));
};

const drawPlayhead = (player, target) => {
  const scaled = player.scale(player.frame);
  const inRange = (scaled >= 0) && (scaled <= 100);
  target.classed('hide', !inRange);
  if (inRange === true) target.style('left', pct(scaled));
};

////////////////////////////////////////
// RANGER

const minThumb = 100; // the smallest pxwidth the scrollthumb can get
const drawRanger = (player, target) => {
  // account for deadzone due to minThumb:
  const deadzone = minThumb / target.node().clientWidth / 2; // px/px => unit
  const wholeScale = scaleLinear().domain([ 0, player.video.duration ]).range([ deadzone, 1 - deadzone ]);
  const centerFrame = (player.range[1] - player.range[0]) / 2 + player.range[0];
  const thumbCenter = wholeScale(centerFrame);

  const leftScale = scaleLinear().domain([ 0, centerFrame ]).range([ 0, thumbCenter - deadzone ]);
  const leftPos = leftScale(player.range[0]);

  const rightScale = scaleLinear().domain([ centerFrame, player.video.duration ]).range([ thumbCenter + deadzone, 1 ]);
  const rightPos = (1 - rightScale(player.range[1]));

  target.select('.vannot-ranger-start').style('left', pct(leftPos));
  target.select('.vannot-ranger-fill').style('left', pct(leftPos));
  target.select('.vannot-ranger-fill').style('right', pct(rightPos));
  target.select('.vannot-ranger-end').style('right', pct(rightPos));
};

////////////////////////////////////////
// DATA TRACKS

// draws the collection of data-driven timeline row at the bottom of the screen.
const trackTemplate = getTemplate('track');
const drawObjectTracks = (player, data, target) => {
  const tracks = instantiateTemplates(target.selectAll('.vannot-track').data(data.objects), trackTemplate);

  tracks.select('.vannot-track-title').text((object) => object.title);
  tracks.select('.vannot-track-color').style('background-color', (object) => object.color);
  tracks.select('.vannot-track-points').each(subdrawTrackpoints(data.frames, player));
};

// draws the collection of trackpoints within a timeline.
const drawTrackpoints = (object, objectFrames, player, target) => {
  const points = instantiateDivs(target.selectAll('.vannot-track-point').data(objectFrames), 'vannot-track-point');

  points
    .style('left', (point) => pct(player.scale(point.frame)))
    .style('background-color', object.color);
};
// convenience function to currying+pulling apart an each call into the standard draw call:
const subdrawTrackpoints = (frames, player) => function(object) {
  const objectFrames = frames.filter((frame) => frame.shapes.some((shape) => shape.objectId === object.id));
  return drawTrackpoints(object, objectFrames, player, select(this));
};


////////////////////////////////////////////////////////////////////////////////
// RENDER SCHEDULER
// Ties into the Player viewmodel and schedules the appropriate drawing
// operations. Queues them up so rapid changes don't cause drawchurn.

const drawer = (app, player) => {
  const tickWrapper = app.select('.vannot-ticks');
  const objectWrapper = app.select('.vannot-objects');
  const playhead = app.select('.vannot-playhead');
  const timecode = app.select('.vannot-timecode');
  const ranger = app.select('.vannot-ranger');

  const draw = (all = false) => {
    const dirty = draw.dirty;
    draw.dirty = {};

    if (all || dirty.playing)
      app.classed('playing', player.playing);

    if (all || dirty.frame)
      drawTimecode(player, timecode);

    if (all || dirty.range) {
      drawRanger(player, ranger);
      drawTicks(player, tickWrapper);
    }

    if (all || dirty.range || dirty.frame)
      drawPlayhead(player, playhead);

    if (all || dirty.range || dirty.shapes)
      drawObjectTracks(player, player.data, objectWrapper);
  };
  draw.dirty = {};
  draw.all = () => draw(true);
  return draw;
};
const reactor = (app, player, canvas) => {
  const draw = drawer(app, player);
  const queue = queuer(draw);
  const mark = (prop) => () => {
    queue();
    draw.dirty[prop] = true;
  };
  player.events.on('change.playing', mark('playing'));
  player.events.on('change.range', mark('range'));
  player.events.on('change.frame', mark('frame'));
  canvas.events.on('change.shapes', mark('shapes'));

  draw.all(); // always draw everything to start.
};

module.exports = { reactor };

