const EventEmitter = require('events');
const { without, concat } = require('ramda');
const { spliceOut, last, pointsEqual, withinBox, distance, midpoint } = require('../util');

class Canvas {
  constructor(player, data) {
    this.player = player;
    this.data = data;

    this.events = new EventEmitter();
    this._initialize();
  }

  _initialize() {
    const updateFrame = () => { this.frame = this.player.frame; };
    this.player.events.on('change.frame', updateFrame);
    updateFrame();

    this.implicitPoints = implicitPoints(this);
  };


  ////////////////////////////////////////
  // FOUNDATION
  // The actual primitive operations that everything else relies on, internal or external.

  // frame is also asymmetric. the frame /number/ goes into the property; the frame /data/
  // comes out. this is so we can manage the automatic creation and destruction of frame
  // data given the presence of shapes.
  get frameObj() { return this._frameObj; }
  set frame(frame) {
    const newFrame = this.data.frames.find((obj) => obj.frame === frame);

    // before doing things with a new frame, possibly deal with the one we were just visiting:
    if (this._frameObj != null) {
      // perf shortcut: if we can and we have to, just reuse the current frame.
      if ((newFrame == null) && (this._frameObj.shapes.length === 0)) {
        this._frameObj.frame = frame;
        return;
      }

      // if the current frame is now useless, remove it.
      if (this._frameObj.shapes.length === 0)
        spliceOut(this._frameObj, this.data.frames);
    }

    if (newFrame == null) {
      this._frameObj = { frame, shapes: [] };
      this.data.frames.push(this._frameObj);
    } else {
      this._frameObj = newFrame;
    }

    this.events.emit('change.frame');
    this.selectedPoints = [];
  };

  // the point-selection API is asymmetric. the only input it takes is simply the collection
  // of points that ought to be selected. the retrieval API does some additional calculation
  // to determine which shapes are partially or completely selected. any implications this
  // information has on drawing state is handled downstream in the drawing layer.
  get selected() {
    // return cached if available; otherwise compute.
    if (this._selected != null) return this._selected;
    const points = this._selectedPoints || [];
    this._selected = { points, wholeShapes: [], partialShapes: [] };

    if (points.length > 0) {
      for (const shape of this.frameObj.shapes) {
        let count = 0; // mutable but way faster
        for (const point of shape.points)
          if (points.includes(point))
            count++;
        if (count === shape.points.length)
          this._selected.wholeShapes.push(shape);
        else if (count > 0)
          this._selected.partialShapes.push(shape);
      }
    }

    // cache this bit of logic for convenience/perf (we will need it):
    if ((this._selected.wholeShapes.length === 1) && (this._selected.partialShapes.length === 0))
      this._selected.shape = this._selected.wholeShapes[0];

    return this._selected;
  }
  set selectedPoints(points) {
    this._selected = null;
    this._selectedPoints = points;
    this.events.emit('change.selected'); // TODO: don't event if set but not changed.
  }

  // we don't actually do anything fancy these properties other than render them, but
  // they're still root pieces of state here and we do still need to track changes.
  get lasso() { return this._lasso; }
  set lasso(lasso) {
    this._lasso = lasso;
    this.events.emit('change.lasso');
  }
  get mouse() { return this._mouse; }
  set mouse(mouse) {
    this._mouse = mouse;
    this.events.emit('change.mouse');
  }

  // and if anybody changes points or shapes they need to tell us manually.
  changedPoints() { this.events.emit('change.points'); }
  changedShapes() { this.events.emit('change.shapes'); }


  ////////////////////////////////////////
  // CALCULATED STATE
  // Read-only calculations on top of foundation state.

  // canvas state determines UI toolset and which interactions are available.
  get state() {
    if (this.wip != null) return 'drawing';
    if ((this.selected.points.length === 0) && (this.wip == null)) return 'normal';
    if ((this.selected.wholeShapes.length > 0) && (this.selected.partialShapes.length === 0)) return 'shapes';
    if (this.selected.partialShapes.length > 0) return 'points';
    throw new Error('unknown state!');
  }

  // wip is simply determined by a shape on the current frame declaring itself so.
  get wip() { return this.frameObj.shapes.find((shape) => shape.wip === true); }

  // the wip segment only exists if there is a wipshape in progress with a point.
  get wipSegment() {
    if (this.wip == null) return null;
    if (this.wip.points.length === 0) return null;
    return [ last(this.wip.points), this.mouse ];
  }


  ////////////////////////////////////////
  // CONVENIENCE METHODS
  // State manipulators which purely manipulate foundation state or frame data.

  // Shape creation:
  startShape() {
    this.frameObj.shapes.push({ id: this.data._seqId++, objectId: -1, points: [], wip: true });
    this.deselect();
  }
  endShape() {
    const wip = this.wip;
    if (wip.points.length < 3) {
      this.removeShape(wip); // TODO: message.
    } else {
      delete wip.wip;
      this.selectedPoints = wip.points;
      this.changedShapes();
    }
  }

  copyLast() {
    // find the previous frame; bail if it doesn't exist.
    const prevFrame = this.player.prevFrame;
    if (prevFrame == null) return; // TODO: show message (or disable in the first place).

    // do our data cloning; keep track of which points to select.
    const pointsToSelect = [];
    prevFrame.shapes.forEach((shape) => {
      // do this a bit manually since we want to copy data, not refs.
      const clone = { id: this.data._seqId++, objectId: shape.objectId, points: [] };
      shape.points.forEach((point) => clone.points.push({ x: point.x, y: point.y }));
      pointsToSelect.push(...clone.points);
      this.frameObj.shapes.push(clone);
    });
    this.selectedPoints = pointsToSelect;

    this.changedShapes();
  }

  // do not call unless only whole shapes are selected.
  duplicateSelected(delta = 0) {
    const duplicates = [];
    for (const shape of this.selected.wholeShapes) {
      const points = shape.points.map(({ x, y }) => ({ x: x + delta, y: y + delta }));
      const duplicate = Object.assign({}, shape, { points });
      this.frameObj.shapes.push(duplicate);
      duplicates.push(duplicate);
    }
    this.selectShapes(duplicates);
    this.changedShapes();
  }

  // Shape selection operations:
  selectShape(shape) { this.selectedPoints = shape.points.slice(); }
  selectShapes(shapes) {
    this.selectedPoints = shapes.map((shape) => shape.points).reduce(concat);
  }

  setLasso(box) {
    if (box == null) {
      this.lasso = null;
    } else {
      this.lasso = box;
      if (pointsEqual(box[0], box[1])) {
        this.selectedPoints = [];
      } else {
        const points = [];
        for (const shape of this.frameObj.shapes)
          for (const point of shape.points)
            if (withinBox(this.lasso, point))
              points.push(point);
        this.selectedPoints = points;
      }
    }
  }

  deselect() { this.selectedPoints = []; }

  // Shape/point destruction:
  removeShape(shape) {
    const points = shape.points;
    spliceOut(shape, this.frameObj.shapes);
    this.changedShapes();
    if (this.selected.points.length > 0)
      this.selectedPoints = without(points, this.selected.points);
  }

  removePoints(points) {
    // easy to remove all wholly-selected shapes:
    for (const shape of this.selected.wholeShapes)
      spliceOut(shape, this.frameObj.shapes);

    // now run through partially-selected shapes and check against points to splice out.
    for (const shape of this.selected.partialShapes) {
      for (const point of points)
        if (shape.points.includes(point))
          spliceOut(point, shape.points);

      // shapes that are no longer viable are cleared out.
      if (shape.points.length < 3)
        spliceOut(shape, this.frameObj.shapes);
    }

    this.deselect();
    this.changedPoints();
    this.changedShapes();
  }
}

const implicitPoints = (canvas) => {
  const implicit = {};

  const compute = () => {
    if (canvas.selected.shape == null)
      return;

    implicit.points = [];
    const shapePoints = canvas.selected.shape.points;
    for (let i = 0; i < shapePoints.length; i++) {
      const it = shapePoints[i];
      const next = shapePoints[((i + 1) === shapePoints.length) ? 0 : (i + 1)];
      const candidate = midpoint(it, next);
      if (distance(candidate, canvas.mouse) < 40)
        implicit.points.push({ coords: candidate, after: it });
    }
  };

  canvas.events.on('change.selected', () => {
    if (canvas.selected.shape == null) {
      implicit.object = null;
      implicit.points = [];
    } else {
      implicit.object = canvas.data.objects.find((object) => object.id === canvas.selected.shape.objectId);
      compute();
    }
  });

  canvas.events.on('change.mouse', compute);

  return implicit;
};

module.exports = { Canvas };

