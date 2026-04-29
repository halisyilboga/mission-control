import React from 'react';

const TaskGanttView: React.FC<{
  projectFilter: string | null;
  tasks: any[];
  onSelectTask: (task: any) => void;
}> = ({ projectFilter, tasks, onSelectTask }) => {
  return (
    <div className="p-4">
      <h2 className="text-xl font-bold mb-4">Gantt View (TODO)</h2>
      <p className="text-gray-500">
        This is a placeholder for the Gantt chart view. Implementation pending.
      </p>
    </div>
  );
};

export default TaskGanttView;